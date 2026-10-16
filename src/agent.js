// The curator agent: request -> LLM search plan -> SoundCloud searches -> LLM selection -> 15-track playlist.
import { PLAYLIST_SIZE } from './config.js';
import { completeJson } from './llm/index.js';

const MAX_PER_ARTIST = 2;

/** UI language → ask the LLM to write titles, descriptions and notes in it (search queries stay as they are). */
export function languageNote(lang) {
  const name = { zh: 'Simplified Chinese (简体中文)', ja: 'Japanese (日本語)' }[lang];
  return name ? `\nWrite every human-readable text you produce (title, description, "why" notes) in ${name}. Keep SoundCloud search queries in whatever language finds the best results.` : '';
}
const SHORTLIST = 90;

const SYSTEM = `You are Mixtape, an expert music curator and DJ with deep knowledge of genres, subgenres, scenes, artists, labels and moods across all eras, with particular fluency in what lives on SoundCloud (underground electronic, hip-hop, lo-fi, bedroom pop, remixes, DJ edits, indie, ambient, world, jazz, etc.).
You always reply with a single JSON object and nothing else.`;

function planPrompt(request, taste) {
  return `A listener wants a playlist. Their request:
"""${request}"""
${taste ? `\nFor light personalisation, here are songs they have liked before (use only if relevant to the request):\n${taste}\n` : ''}
Design SoundCloud search queries that will surface great candidate tracks for this request.
Rules:
- 7 to 9 queries, each 1-5 words, the kind of text people put in SoundCloud titles/tags (genre names, subgenres, scene words, mood + genre combos, notable artists of the style).
- Cover the request from different angles so results are diverse; do not just repeat the request.
- If the listener named artists/songs, include queries for them AND for similar artists.
- Avoid queries that mostly return DJ mixes or podcasts unless asked for mixes.

Return JSON:
{"title": "evocative playlist title, max 6 words", "description": "one sentence on the vibe", "queries": ["...", "..."]}`;
}

function selectPrompt(request, plan, candidates, count) {
  const lines = candidates.map((t) => {
    const mins = `${Math.floor(t.durationMs / 60000)}:${String(Math.round((t.durationMs % 60000) / 1000)).padStart(2, '0')}`;
    const meta = [t.genre, ...t.tags.slice(0, 4)].filter(Boolean).join(', ');
    return `${t.id} | ${t.artist} – ${t.title} | ${meta || '-'} | ${mins} | ${fmtCount(t.plays)} plays`;
  }).join('\n');
  return `Listener request: """${request}"""
Working title: "${plan.title}" — ${plan.description}

Candidate tracks from SoundCloud (id | artist – title | genre/tags | length | plays):
${lines}

Pick exactly ${count} tracks that best fit the request and sequence them as a great listening experience (strong opener, natural energy arc, no jarring jumps).
Rules:
- Use only ids from the list, each once.
- At most ${MAX_PER_ARTIST} tracks per artist.
- Prefer real songs that match the mood/genre over off-topic popular uploads; skip obvious spam, "type beat" ads, sped-up/nightcore re-uploads and full DJ mixes unless the request asks for them.
- You may refine the title and description.

Return JSON:
{"title": "...", "description": "...", "tracks": [{"id": "123", "why": "max 12 words on why it fits"}]}`;
}

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n || 0);
}

const normKey = (t) => `${t.artist}|${t.title}`.toLowerCase().replace(/\(.*?\)|\[.*?\]|official|audio|video|free download|[^a-z0-9|]+/g, '');

export class Curator {
  constructor({ llm, soundcloud, library }) {
    this.llm = llm;
    this.sc = soundcloud;
    this.library = library;
  }

  /** Run several SoundCloud searches and merge into a de-duplicated, pre-ranked candidate pool. */
  async searchCandidates(queries, { perQuery = 40, onProgress = () => {} } = {}) {
    const pool = new Map();
    const seenKeys = new Set();
    const errors = [];
    let qi = 0;
    const worker = async () => {
      while (qi < queries.length) {
        const qIndex = qi++;
        const q = queries[qIndex];
        try {
          const results = await this.sc.searchTracks(q, { limit: perQuery });
          onProgress({ stage: 'search', message: `“${q}” → ${results.length} tracks` });
          results.forEach((t, rank) => {
            const key = normKey(t);
            const existing = pool.get(t.id);
            // Score: search relevance rank, popularity (log-scaled), and agreement across queries.
            const s = (perQuery - rank) / perQuery * 2 + Math.log10((t.plays || 0) + 10) / 3;
            if (existing) { existing.score += s + 0.75; existing.queries.push(q); return; }
            if (seenKeys.has(key)) return; // re-upload of a track we already have
            seenKeys.add(key);
            pool.set(t.id, { track: t, score: s, queries: [q] });
          });
        } catch (e) {
          errors.push(`${q}: ${e.message}`);
          onProgress({ stage: 'search', message: `“${q}” failed: ${e.message}` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queries.length) }, worker));
    if (!pool.size && errors.length) throw new Error('All SoundCloud searches failed. ' + errors[0]);
    return [...pool.values()].sort((a, b) => b.score - a.score).map((e) => ({ ...e.track, _score: e.score, _queries: e.queries }));
  }

  /** Full autonomous pipeline using the configured LLM. */
  async generate(request, { onProgress = () => {}, count = PLAYLIST_SIZE, lang = '' } = {}) {
    const SYS = SYSTEM + languageNote(lang);
    request = String(request || '').trim();
    if (!request) throw new Error('Describe what you want to listen to.');
    const taste = this.library.tasteSummary();
    const warnings = [];

    onProgress({ stage: 'plan', message: `Asking ${this.llm.describe()} for a search plan…` });
    let plan;
    try {
      plan = await completeJson(this.llm, { system: SYS, prompt: planPrompt(request, taste) });
      if (!Array.isArray(plan.queries) || !plan.queries.length) throw new Error('no queries in plan');
    } catch (e) {
      warnings.push(`LLM planning failed (${e.message}); searching your request directly.`);
      onProgress({ stage: 'plan', message: warnings.at(-1) });
      plan = { title: request.slice(0, 40), description: '', queries: fallbackQueries(request) };
    }
    plan.queries = [...new Set(plan.queries.map((q) => String(q).trim()).filter(Boolean))].slice(0, 10);
    onProgress({ stage: 'plan', message: `Plan: “${plan.title}” — searching ${plan.queries.length} queries`, plan });

    let candidates = await this.searchCandidates(plan.queries, { onProgress });
    if (candidates.length < count * 2) {
      const extra = fallbackQueries(request).filter((q) => !plan.queries.includes(q));
      if (extra.length) {
        onProgress({ stage: 'search', message: 'Few results — broadening the search…' });
        const more = await this.searchCandidates(extra, { onProgress }).catch(() => []);
        const ids = new Set(candidates.map((t) => t.id));
        candidates = [...candidates, ...more.filter((t) => !ids.has(t.id))];
      }
    }
    if (!candidates.length) throw new Error('SoundCloud returned no playable tracks for this request. Try different wording.');
    const shortlist = candidates.slice(0, SHORTLIST);
    onProgress({ stage: 'select', message: `Curating ${count} from ${shortlist.length} candidates…` });

    let picks = [], title = plan.title, description = plan.description;
    try {
      const sel = await completeJson(this.llm, { system: SYS, prompt: selectPrompt(request, plan, shortlist, Math.min(count, shortlist.length)) });
      picks = (sel.tracks || []).map((x) => (typeof x === 'object' ? x : { id: x })).map((x) => ({ id: String(x.id), why: x.why || '' }));
      title = sel.title || title;
      description = sel.description || description;
    } catch (e) {
      warnings.push(`LLM selection failed (${e.message}); used search ranking instead.`);
      onProgress({ stage: 'select', message: warnings.at(-1) });
    }

    const { tracks, notes } = assemble(picks, shortlist, candidates, count);
    if (tracks.length < count) warnings.push(`Only ${tracks.length} playable tracks were found.`);
    const playlist = this.library.createPlaylist({ title, description, prompt: request, tracks, notes });
    onProgress({ stage: 'done', message: `Created “${playlist.title}” with ${playlist.tracks.length} tracks`, playlistId: playlist.id });
    return { playlist, warnings, plan };
  }

  /** Host-LLM path (e.g. Claude over MCP chose the ids itself). Fills up to `count` if fewer were given. */
  async createFromIds({ ids, title, description, prompt = '', notes = {}, count = PLAYLIST_SIZE }) {
    const uniq = [...new Set(ids.map(String))];
    const known = uniq.map((id) => this.sc.trackCache.get(id)).filter(Boolean);
    const missing = uniq.filter((id) => !this.sc.trackCache.has(id));
    const fetched = missing.length ? await this.sc.getTracks(missing) : [];
    const byId = new Map([...known, ...fetched].filter(Boolean).map((t) => [t.id, t]));
    const tracks = uniq.map((id) => byId.get(id)).filter(Boolean).slice(0, count);
    if (!tracks.length) throw new Error('None of those track ids could be found on SoundCloud.');
    return this.library.createPlaylist({ title, description, prompt, tracks, notes });
  }
}

/** Validate LLM picks against the candidate pool, enforce per-artist cap, top up from ranking. */
export function assemble(picks, shortlist, all, count) {
  const byId = new Map(all.map((t) => [t.id, t]));
  const tracks = [], notes = {}, used = new Set(), perArtist = new Map();
  const add = (t, why, cap = MAX_PER_ARTIST) => {
    if (!t || used.has(t.id) || tracks.length >= count) return;
    const a = t.artist.toLowerCase();
    if ((perArtist.get(a) || 0) >= cap) return;
    used.add(t.id); perArtist.set(a, (perArtist.get(a) || 0) + 1);
    tracks.push(t); if (why) notes[t.id] = why;
  };
  for (const p of picks) add(byId.get(p.id), p.why);
  for (const t of shortlist) add(t);
  for (const t of all) add(t);
  for (const t of all) add(t, '', Infinity); // last resort: relax artist cap
  return { tracks: tracks.map(({ _score, _queries, ...t }) => t), notes };
}

function fallbackQueries(request) {
  const clean = request.toLowerCase().replace(/[^a-z0-9&'\s-]/g, ' ').replace(/\b(i|i'm|want|wanna|some|something|music|songs?|tracks?|play|me|for|to|listen|like|that|is|a|an|the|and|with|of|please|give)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  const qs = [request.slice(0, 80)];
  if (clean && clean !== request.toLowerCase()) qs.push(clean);
  if (words.length > 2) qs.push(words.slice(0, 2).join(' '), words.slice(-2).join(' '));
  return [...new Set(qs)];
}
