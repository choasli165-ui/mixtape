// "My Songs" (the user's own list, matched on SoundCloud) and "For You" (recommendations built from it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, PLAYLIST_SIZE } from './config.js';
import { MINE_ID, FOR_YOU_ID } from './library.js';
import { completeJson } from './llm/index.js';
import { assemble, languageNote } from './agent.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
// data/my-songs.json is your own (git-ignored) list; the repository ships a small starter list.
const BUNDLED = fs.existsSync(path.join(DATA, 'my-songs.json')) ? path.join(DATA, 'my-songs.json') : path.join(DATA, 'my-songs.example.json');
/** A user copy in ~/.mixtape-agent wins over the bundled list, so it can be edited without touching the app. */
export const seedPath = () => process.env.MIXTAPE_SEED || (fs.existsSync(path.join(DATA_DIR, 'my-songs.json')) ? path.join(DATA_DIR, 'my-songs.json') : BUNDLED);
export const loadSeed = () => JSON.parse(fs.readFileSync(seedPath(), 'utf8'));

const VERSION_WORDS = /\b(slowed|super|ultra|over|sped|speed|up|reverb|bass|boosted|remix|edit|version|phonk|techno|official|audio|video|free|download|prod|by)\b/g;
export const tokens = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(VERSION_WORDS, ' ')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const compact = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** 0..1 similarity between a seed entry and a SoundCloud track. */
export function matchScore(seed, t) {
  const want = tokens(seed.title);
  const haveTitle = new Set(tokens(t.title));
  if (!want.length) return 0;
  // CJK titles don't split into words; fall back to substring containment.
  const titleHit = want.filter((w) => haveTitle.has(w) || compact(t.title).includes(w)).length / want.length;
  const a = compact(seed.artist);
  const artistHit = a && [t.artist, t.uploader, t.title].some((x) => compact(x).includes(a)) ? 1 : 0;
  let score = titleHit * 0.7 + artistHit * 0.25;
  // Version words are stripped above; use them as a tie-breaker so "Slowed" seeds prefer slowed uploads.
  const EDITS = ['slowed', 'sped', 'super', 'ultra', 'reverb', 'boosted', 'techno', 'phonk', 'over'];
  const vw = String(seed.version || '').toLowerCase().split(/\W+/).filter((w) => EDITS.includes(w));
  const tl = String(t.title).toLowerCase();
  if (vw.length) score += 0.05 * (vw.filter((w) => tl.includes(w)).length / vw.length);
  else if (!EDITS.some((w) => tl.includes(w))) score += 0.05; // no edit requested: prefer the original
  return score;
}

export async function matchSeedTrack(sc, seed) {
  const queries = [`${seed.artist} ${seed.title}${seed.version ? ' ' + seed.version : ''}`, `${seed.artist} ${seed.title}`, seed.title];
  let best = null;
  for (const q of [...new Set(queries)]) {
    let results = [];
    try { results = await sc.searchTracks(q, { limit: 20 }); } catch { continue; }
    for (const t of results) {
      const s = matchScore(seed, t);
      if (!best || s > best.score || (s === best.score && t.plays > best.track.plays)) best = { track: t, score: s };
    }
    if (best && best.score >= 0.95) break;
  }
  return best && best.score >= 0.7 ? best.track : null;
}

/** Build "My Songs" from the seed list. Returns { playlist, missing }. */
export async function importMySongs(app, { onProgress = () => {} } = {}) {
  const seed = loadSeed();
  const found = [], missing = [], seen = new Set();
  let i = 0;
  const worker = async () => {
    while (i < seed.tracks.length) {
      const idx = i++, s = seed.tracks[idx];
      const t = await matchSeedTrack(app.sc, s).catch(() => null);
      if (t && !seen.has(t.id)) { seen.add(t.id); found[idx] = t; }
      else if (!t) missing.push(`${s.artist} – ${s.title}`);
      onProgress({ stage: 'mine', message: `${t ? '✓' : '✗'} ${s.artist} – ${s.title}` });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const tracks = found.filter(Boolean);
  const playlist = app.library.upsertPlaylist({
    id: MINE_ID, builtin: true, title: seed.title || 'My Songs',
    description: `${tracks.length} of ${seed.tracks.length} songs from your list found on SoundCloud.`,
    tracks, meta: { missing, seedCount: seed.tracks.length },
  });
  return { playlist, missing };
}

/** Build "For You": 15 tracks related to My Songs + Liked Songs, excluding what's already there. */
export async function refreshForYou(app, { onProgress = () => {}, count = PLAYLIST_SIZE } = {}) {
  const seed = loadSeed();
  const lib = app.library;
  const mine = lib.getPlaylist(MINE_ID)?.tracks || [];
  const liked = lib.getPlaylist('liked')?.tracks || [];
  const ownIds = new Set([...mine, ...liked].map((t) => t.id));
  const ownKeys = new Set([...mine, ...liked, ...seed.tracks].map((t) => tokens(t.title).join(' ')));
  const recentForYou = new Set((lib.getPlaylist(FOR_YOU_ID)?.tracks || []).map((t) => t.id));

  // Queries: curated genre/artist list, plus artists from likes, shuffled so each refresh differs.
  const likedArtists = liked.slice(0, 10).map((t) => t.artist);
  const pool = [...new Set([...(seed.recommend?.queries || []), ...likedArtists])];
  const queries = shuffle(pool).slice(0, 10);
  onProgress({ stage: 'search', message: `Searching ${queries.length} related queries…` });
  let candidates = await app.curator.searchCandidates(queries, { perQuery: 30, onProgress });
  candidates = candidates.filter((t) => !ownIds.has(t.id) && !ownKeys.has(tokens(t.title).join(' ')));
  // Rotate: tracks shown in the previous For You go to the back.
  candidates.sort((a, b) => (recentForYou.has(a.id) - recentForYou.has(b.id)) || (b._score - a._score));
  if (!candidates.length) throw new Error('No recommendations found on SoundCloud right now.');

  const shortlist = candidates.slice(0, 90);
  let picks = [], title = 'For You', description = 'Fresh tracks related to your library.';
  if (app.llm) {
    try {
      onProgress({ stage: 'select', message: `Asking ${app.llm.describe()} to pick ${count}…` });
      const taste = [...mine, ...liked].slice(0, 40).map((t) => `${t.artist} – ${t.title}`).join('\n');
      const lines = shortlist.map((t) => `${t.id} | ${t.artist} – ${t.title} | ${[t.genre, ...t.tags.slice(0, 3)].filter(Boolean).join(', ') || '-'}`).join('\n');
      const sel = await completeJson(app.llm, {
        system: 'You are Mixtape, an expert music curator. Reply with a single JSON object only.' + languageNote(app.cfg.ui?.language),
        prompt: `The listener's library:\n${taste}\n\nTheir taste: ${seed.recommend?.request || ''}\n\nCandidates (id | artist – title | tags):\n${lines}\n\nPick exactly ${count} NEW tracks they would most likely love, max 2 per artist, sequenced well. Skip spam and "type beat" ads.\nReturn {"tracks":[{"id":"...","why":"max 10 words"}]}`,
      });
      picks = (sel.tracks || []).map((x) => ({ id: String(x.id ?? x), why: x.why || '' }));
    } catch (e) { onProgress({ stage: 'select', message: `LLM unavailable (${e.message}); using ranking.` }); }
  }
  const { tracks, notes } = assemble(picks, shortlist, candidates, count);
  const playlist = lib.upsertPlaylist({ id: FOR_YOU_ID, builtin: true, title, description, tracks, notes, prompt: seed.recommend?.request || '' });
  onProgress({ stage: 'done', message: `For You updated with ${tracks.length} tracks` });
  return { playlist };
}

/** First run: build both built-in playlists if missing. Safe to call repeatedly. */
export async function ensureDefaults(app, log = () => {}) {
  try {
    if (!app.library.hasPlaylist(MINE_ID)) {
      log('Matching your song list on SoundCloud…');
      const r = await importMySongs(app);
      log(`My Songs: ${r.playlist.tracks.length} found${r.missing.length ? `, missing: ${r.missing.join('; ')}` : ''}`);
    }
    if (!app.library.hasPlaylist(FOR_YOU_ID)) {
      log('Building For You recommendations…');
      const r = await refreshForYou(app);
      log(`For You: ${r.playlist.tracks.length} tracks`);
    }
  } catch (e) { log(`Default playlists failed: ${e.message}`); }
}

function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
