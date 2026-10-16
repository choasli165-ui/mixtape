// Mixtape web player
import { LANGUAGES, detectLanguage, setLanguage, currentLanguage, t as tr } from '/i18n.js';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.2 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.8 0 6 3.8 4.5 7.3C19.5 16.4 12 21 12 21z"/></svg>';
const NOTE = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const SPARK = '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
const BULB = '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/></svg>';
const WAND = '<svg viewBox="0 0 24 24"><path d="M4 20 15 9M14 4l1.5 3L19 8.5 15.5 10 14 13l-1.5-3L9 8.5 12.5 7z"/></svg>';
const BUILTIN_ART = { liked: ['liked', HEART], inspirations: ['insp', BULB], mine: ['mine', NOTE], 'for-you': ['foryou', SPARK] };
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------------------------------------------------------------- state
const state = {
  playlists: [],
  view: { kind: 'compose', id: null, data: null },
  liked: new Set(),
  queue: [], order: [], pos: -1,
  playlistId: null, playlistTitle: '',
  shuffle: false, repeat: 'off', volume: 0.8,
  playing: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('mixtape.prefs') || '{}');
  Object.assign(state, { shuffle: !!saved.shuffle, repeat: saved.repeat || 'off', volume: saved.volume ?? 0.8 });
} catch { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem('mixtape.prefs', JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat, volume: state.volume })); } catch { /* ignore */ } };
const current = () => state.queue[state.order[state.pos]] || null;

// ---------------------------------------------------------------- unavailable tracks
// Songs that failed to load/play are greyed out and skipped. Marks expire after a while (links can come back),
// and clicking a greyed-out song retries it.
const FAIL_TTL = 6 * 3600e3;
const failed = new Map();
try { for (const [id, at] of Object.entries(JSON.parse(localStorage.getItem('mixtape.failed') || '{}'))) if (Date.now() - at < FAIL_TTL) failed.set(id, at); } catch {}
const saveFailed = () => { try { localStorage.setItem('mixtape.failed', JSON.stringify(Object.fromEntries(failed))); } catch {} };
const isDead = (id) => failed.has(String(id));
function markFailed(id) {
  failed.set(String(id), Date.now()); saveFailed();
  document.querySelectorAll(`.row[data-id="${CSS.escape(String(id))}"]`).forEach((r) => { r.classList.add('dead'); r.title = tr('Unavailable — click to try again'); });
}
function clearFailed(id) {
  if (!failed.delete(String(id))) return;
  saveFailed();
  document.querySelectorAll(`.row[data-id="${CSS.escape(String(id))}"]`).forEach((r) => { r.classList.remove('dead'); r.title = ''; });
}

// ---------------------------------------------------------------- audio engines
// 1) Native <audio> via the local proxy (progressive MP3 or HLS through hls.js / native HLS)
// 2) Fallback: SoundCloud's official embed widget, if the stream can't be resolved.
const audio = $('#audio');
let hls = null, widget = null, engine = 'audio', loadToken = 0;
const widgetState = { position: 0, duration: 0, paused: true };

function destroyHls() { if (hls) { hls.destroy(); hls = null; } }
function destroyWidget() { if (widget) { try { widget.pause(); } catch {} widget = null; $('#widgetHost').innerHTML = ''; } }

// A song must start within this time, or it's treated as unavailable.
const LOAD_TIMEOUT = 15000, WIDGET_TIMEOUT = 12000, STALL_TIMEOUT = 25000;
let watchdog = 0, lastProgress = 0, wantPlay = false;
function armWatchdog(track, token, ms, stage) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (token !== loadToken) return;
    if (stage === 'audio') fallbackToWidget(track, token, new Error('timeout'));
    else onTrackError(track, new Error('timeout'));
  }, ms);
}
const disarm = () => { clearTimeout(watchdog); watchdog = 0; };

async function loadTrack(track, autoplay = true) {
  const token = ++loadToken;
  setLoading(true);
  disarm(); lastProgress = Date.now(); wantPlay = autoplay;
  if (autoplay) armWatchdog(track, token, LOAD_TIMEOUT, 'audio');
  destroyHls(); destroyWidget(); audio.pause(); audio.removeAttribute('src'); audio.load();
  try {
    const s = await api('GET', `/api/stream/${track.id}`);
    if (token !== loadToken) return;
    engine = 'audio';
    if (s.kind === 'hls' && !audio.canPlayType('application/vnd.apple.mpegurl')) {
      await waitFor(() => window.Hls, 4000);
      if (!window.Hls?.isSupported()) throw new Error('HLS unsupported');
      hls = new window.Hls({ enableWorker: true });
      hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal && token === loadToken) fallbackToWidget(track, token); });
      hls.loadSource(s.src); hls.attachMedia(audio);
    } else {
      audio.src = s.src;
    }
    audio.volume = state.volume;
    if (autoplay) await audio.play().catch(onPlayBlocked);
  } catch (e) {
    if (token === loadToken) fallbackToWidget(track, token, e);
  }
}

function waitFor(fn, ms) {
  return new Promise((resolve) => { const t0 = Date.now(); (function poll() { if (fn() || Date.now() - t0 > ms) resolve(); else setTimeout(poll, 100); })(); });
}

async function loadWidgetApi() {
  if (window.SC?.Widget) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://w.soundcloud.com/player/api.js'; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function fallbackToWidget(track, token, err) {
  if (!track.permalinkUrl) return onTrackError(track, err);
  try {
    await loadWidgetApi();
    if (token !== loadToken) return;
    destroyHls(); audio.removeAttribute('src');
    engine = 'widget';
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.permalinkUrl)}&auto_play=true&visual=false&show_artwork=false`;
    $('#widgetHost').innerHTML = ''; $('#widgetHost').appendChild(iframe);
    widget = window.SC.Widget(iframe);
    armWatchdog(track, token, WIDGET_TIMEOUT, 'widget');
    const E = window.SC.Widget.Events;
    widget.bind(E.READY, () => { widget.setVolume(state.volume * 100); widget.getDuration((d) => { widgetState.duration = d / 1000; }); widget.play(); });
    widget.bind(E.PLAY, () => { disarm(); failStreak = 0; lastProgress = Date.now(); widgetState.paused = false; onPlayState(true); setLoading(false); });
    widget.bind(E.PAUSE, () => { widgetState.paused = true; onPlayState(false); });
    widget.bind(E.PLAY_PROGRESS, (e) => { lastProgress = Date.now(); widgetState.position = e.currentPosition / 1000; if (!widgetState.duration && e.relativePosition) widgetState.duration = widgetState.position / e.relativePosition; onTime(); });
    widget.bind(E.FINISH, () => onEnded());
    widget.bind(E.ERROR, () => onTrackError(track));
  } catch (e) { onTrackError(track, e); }
}

const player = {
  play() { return engine === 'widget' ? widget?.play() : audio.play().catch(onPlayBlocked); },
  pause() { engine === 'widget' ? widget?.pause() : audio.pause(); },
  get paused() { return engine === 'widget' ? widgetState.paused : audio.paused; },
  get position() { return engine === 'widget' ? widgetState.position : audio.currentTime; },
  get duration() {
    if (engine === 'widget') return widgetState.duration || (current()?.durationMs || 0) / 1000;
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current()?.durationMs || 0) / 1000;
  },
  seek(sec) { sec = Math.max(0, Math.min(sec, this.duration - 0.5)); engine === 'widget' ? widget?.seekTo(sec * 1000) : (audio.currentTime = sec); },
  setVolume(v) { state.volume = v; audio.volume = v; widget?.setVolume(v * 100); savePrefs(); renderVolume(); },
};

function onPlayBlocked(e) {
  if (e?.name === 'NotAllowedError') { disarm(); wantPlay = false; onPlayState(false); setLoading(false); toast('Press play to start — the browser blocked autoplay.'); }
}

let failStreak = 0, skipped = 0, skipToastTimer = 0;
function onTrackError(track, err) {
  if (!track || track.id !== current()?.id) return; // a stale error from a song we already left
  disarm(); setLoading(false);
  console.warn('Playback failed', track.title, err);
  failStreak++;
  if (failStreak >= 4 && !checkingNet) {
    // many failures in a row: is the internet down, or are these songs really broken?
    checkingNet = true;
    const token = loadToken;
    api('GET', '/api/net').catch(() => ({ online: navigator.onLine })).then((r) => {
      checkingNet = false;
      if (token !== loadToken) return;
      if (r.online) { failStreak = 0; skipAndContinue(track); return; }
      failStreak = 0; wantPlay = false; player.pause(); onPlayState(false);
      clearTimeout(skipToastTimer); skipped = 0;
      toast('Several songs in a row couldn’t load. Check your internet connection, then press play.', true);
    });
    return;
  }
  skipAndContinue(track);
}
let checkingNet = false;
function skipAndContinue(track) {
  if (!track.local) markFailed(track.id); // a saved creation isn't 'unavailable on SoundCloud'
  skipped++;
  clearTimeout(skipToastTimer);
  skipToastTimer = setTimeout(() => { toast(skipped > 1 ? `Skipped ${skipped} unavailable songs` : 'Skipped an unavailable song'); skipped = 0; }, 600);
  next(true);
}
// stall detection: playing but no progress for a long time → treat as broken and move on
setInterval(() => {
  const t = current();
  if (!t || watchdog) return; // still starting: the load watchdog handles that
  const active = engine === 'audio' ? (!audio.paused && !audio.ended) : (widget && !widgetState.paused);
  if (active && Date.now() - lastProgress > STALL_TIMEOUT) onTrackError(t, new Error('stalled'));
}, 3000);

audio.addEventListener('playing', () => { disarm(); failStreak = 0; lastProgress = Date.now(); setLoading(false); onPlayState(true); schedulePrecache(); });
audio.addEventListener('timeupdate', () => { if (!audio.paused) lastProgress = Date.now(); });

// ---- pre-cache: while a song plays, download the next ones so they start instantly
let precacheTimer;
function upcoming(n = 2) {
  const out = [];
  for (let k = 1; k <= n && state.queue.length > 1; k++) {
    let p = state.pos + k;
    if (p >= state.order.length) { if (state.repeat !== 'all') break; p %= state.order.length; }
    const t = state.queue[state.order[p]];
    if (t && !t.local && t.id !== current()?.id) out.push(t.id); // your own creations are already on this PC
  }
  return out;
}
function schedulePrecache() {
  clearTimeout(precacheTimer);
  // wait a few seconds so the current song gets the bandwidth first
  precacheTimer = setTimeout(() => {
    const ids = upcoming(2);
    if (ids.length) api('POST', '/api/precache', { ids }).then((r) => (r.unavailable || []).forEach(markFailed)).catch(() => {});
  }, 4000);
}
audio.addEventListener('pause', () => onPlayState(false));
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
audio.addEventListener('timeupdate', onTime);
audio.addEventListener('ended', () => onEnded());
audio.addEventListener('error', () => { if (engine === 'audio' && audio.getAttribute('src') && current()) { armWatchdog(current(), loadToken, WIDGET_TIMEOUT, 'widget'); fallbackToWidget(current(), loadToken); } });

// ---------------------------------------------------------------- queue control
function startPlaylist(pl, index = 0, { shuffle, retry = false } = {}) {
  if (!pl?.tracks?.length) return toast('This playlist is empty');
  state.queue = pl.tracks.map((t) => ({ ...t }));
  state.playlistId = pl.id; state.playlistTitle = pl.title;
  if (typeof shuffle === 'boolean') state.shuffle = shuffle;
  buildOrder(Math.max(0, Math.min(index, pl.tracks.length - 1)));
  failStreak = 0;
  if (retry) clearFailed(current()?.id); // the user clicked a greyed-out song: try it again
  else if (isDead(current()?.id)) { const p = findPlayable(1, false); if (p == null) { toast('No playable songs left in this list'); return; } state.pos = p; }
  goCurrent();
  savePrefs(); renderModes();
}

/** Play order over queue indices. Shuffled orders start with `startIdx` when given. */
function buildOrder(startIdx) {
  const n = state.queue.length;
  const idx = [...Array(n).keys()];
  if (state.shuffle) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    if (startIdx != null) { idx.splice(idx.indexOf(startIdx), 1); idx.unshift(startIdx); }
    state.order = idx; state.pos = 0;
  } else {
    state.order = idx; state.pos = startIdx ?? 0;
  }
}

/** Next/previous position whose song isn't marked unavailable (dir = +1 / −1). null if none. */
function findPlayable(dir, auto, from = state.pos) {
  const n = state.order.length;
  for (let step = 1; step <= n; step++) {
    let p = from + dir * step;
    if (p >= n || p < 0) {
      if (auto && state.repeat !== 'all') return null; // end of the list
      p = ((p % n) + n) % n;
    }
    if (!isDead(state.queue[state.order[p]]?.id)) return p;
  }
  return null;
}

function next(auto = false) {
  if (!state.queue.length) return;
  const p = findPlayable(1, auto);
  if (p == null) {
    player.pause(); onPlayState(false); wantPlay = false;
    if (state.queue.every((t) => isDead(t.id))) toast('No playable songs left in this list');
    return;
  }
  state.pos = p;
  goCurrent();
}

function prev() {
  if (!state.queue.length) return;
  if (player.position > 3) return player.seek(0);
  const p = findPlayable(-1, false);
  if (p != null) state.pos = p;
  goCurrent();
}

function goCurrent() {
  const t = current();
  if (!t) return;
  renderNowPlaying(); renderTrackHighlight(); renderNav();
  loadTrack(t);
  reportState();
}

function onEnded() {
  if (state.repeat === 'one') { player.seek(0); player.play(); return; }
  next(true);
}

function toggle() {
  if (!current()) {
    const pl = state.view.data;
    if (pl?.tracks?.length) startPlaylist(pl, 0);
    return;
  }
  if (player.paused) { wantPlay = true; lastProgress = Date.now(); player.play(); } else { wantPlay = false; player.pause(); }
}

function setShuffle(on) {
  state.shuffle = on;
  const curIdx = state.order[state.pos];
  if (state.queue.length) {
    if (on) buildOrder(curIdx ?? 0);
    else { state.order = [...state.queue.keys()]; state.pos = curIdx ?? 0; }
  }
  savePrefs(); renderModes(); reportState(); if (state.playing) schedulePrecache();
}

function setRepeat(mode) {
  state.repeat = mode || { off: 'all', all: 'one', one: 'off' }[state.repeat];
  savePrefs(); renderModes(); reportState();
}

// ---------------------------------------------------------------- likes
async function toggleLike(track) {
  if (!track) return;
  const want = !state.liked.has(track.id);
  setLikedLocal(track.id, want);
  try {
    const { liked, ...meta } = track;
    await api('POST', `/api/likes/${track.id}`, { liked: want, track: meta });
    toast(want ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  } catch (e) { setLikedLocal(track.id, !want); toast(e.message, true); }
}

function setLikedLocal(id, on) {
  on ? state.liked.add(id) : state.liked.delete(id);
  document.querySelectorAll(`.heart[data-id="${id}"]`).forEach((b) => { b.classList.toggle('on', on); b.classList.remove('pop'); void b.offsetWidth; if (on) b.classList.add('pop'); });
  if (current()?.id === id) renderNowPlaying();
}

// ---------------------------------------------------------------- rendering
function renderNav() {
  const ul = $('#playlistNav');
  ul.innerHTML = state.playlists.map((p) => {
    const active = state.view.kind === 'playlist' && state.view.id === p.id;
    const art = BUILTIN_ART[p.id];
    const thumb = art ? `<span class="thumb ${art[0]}">${art[1]}</span>` : `<span class="thumb" style="${p.artwork ? `background-image:url('${esc(p.artwork)}')` : ''}"></span>`;
    return `<li class="${state.playlistId === p.id ? 'playing' : ''}"><button data-pl="${esc(p.id)}" class="${active ? 'active' : ''}">${thumb}<span class="nl"><b ${p.builtin ? '' : 'data-notr'}>${esc(p.title)}</b><small>${p.builtin ? 'Playlist · ' : ''}${p.count} tracks</small></span></button></li>`;
  }).join('');
}

function renderPlaylist(pl) {
  const liked = pl.id === 'liked';
  const builtin = liked || pl.builtin;
  const eyebrow = { liked: 'Built-in collection', inspirations: 'Your creations · saved on this PC', mine: 'Your library · default', 'for-you': `Recommended for you · ${new Date(pl.createdAt).toLocaleDateString()}` }[pl.id];
  $('#plEyebrow').textContent = eyebrow || `Curated mix · ${new Date(pl.createdAt).toLocaleDateString()}`;
  const title = $('#plTitle');
  title.textContent = pl.title; title.contentEditable = String(!builtin);
  title.toggleAttribute('data-notr', !builtin);
  $('#plDesc').toggleAttribute('data-notr', !builtin);
  $('#plPrompt').toggleAttribute('data-notr', !builtin && pl.id !== 'liked');
  $('#plDesc').textContent = pl.description || '';
  const missing = pl.meta?.missing || [];
  $('#plPrompt').textContent = pl.id === 'liked' && pl.offline ? offlineText(pl.offline) : pl.id === 'mine' ? (missing.length ? `Not found on SoundCloud: ${missing.join(' · ')}` : '') : pl.id === 'for-you' ? 'Based on My Songs and your likes.' : (pl.prompt ? `“${pl.prompt}”` : '');
  $('#plDelete').classList.toggle('hidden', builtin);
  const regen = $('#plRegen');
  regen.classList.toggle('hidden', liked || pl.id === 'inspirations' || (!pl.prompt && !pl.builtin));
  regen.lastChild.textContent = pl.id === 'for-you' ? 'Refresh' : pl.id === 'mine' ? 'Re-match' : 'Remix';
  regen.title = pl.id === 'for-you' ? 'Get 15 new recommendations' : pl.id === 'mine' ? 'Search SoundCloud for your list again' : 'Make a new mix from the same request';
  const cover = $('#plCover');
  if (BUILTIN_ART[pl.id]) { cover.className = `cover ${BUILTIN_ART[pl.id][0]}`; cover.innerHTML = BUILTIN_ART[pl.id][1]; }
  else {
    const arts = [...new Set(pl.tracks.map((t) => t.artwork).filter(Boolean))].slice(0, 4);
    cover.className = 'cover' + (arts.length < 4 ? ' single' : '');
    cover.innerHTML = (arts.length < 4 ? arts.slice(0, 1) : arts).map((a) => `<div style="background-image:url('${esc(a)}')"></div>`).join('');
  }
  $('#emptyLiked').classList.toggle('hidden', !(liked && !pl.tracks.length));
  $('#emptyInspirations').classList.toggle('hidden', !(pl.id === 'inspirations' && !pl.tracks.length));
  $('#plPlay').disabled = $('#plShuffle').disabled = !pl.tracks.length;
  $('#trackList').innerHTML = pl.tracks.map((t, i) => rowHTML(t, i, i + 1, { draggable: pl.tracks.length > 1 })).join('');
  renderTrackHighlight();
}

const ADD_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
/** One song row (playlists and search results). */
function rowHTML(t, i, num = i + 1, { draggable = false } = {}) {
  const dead = isDead(t.id) && !t.local;
  const tip = dead ? tr('Unavailable — click to try again') : draggable ? tr('Drag to change the order') : '';
  const note = t.local
    ? `<button class="reopen" title="Open in Creation Mode">${WAND}<span>Open in Creation Mode</span></button>`
    : `<span class="unavail">Unavailable</span><span data-notr title="${esc(t.note || t.genre || '')}">${esc(t.note || t.genre || '')}</span>`;
  return `
    <div class="row ${dead ? 'dead' : ''} ${t.local ? 'local' : ''}" data-id="${esc(t.id)}" data-index="${i}" ${draggable ? 'draggable="true"' : ''} ${tip ? `title="${esc(tip)}"` : ''}>
      <div class="num"><span class="n">${num}</span><span class="pi">${PLAY_ICON}</span><span class="eq"><i></i><i></i><i></i></span></div>
      <div class="ti"><div class="art ${t.local && !t.artwork ? 'insp' : ''}" style="${t.artwork ? `background-image:url('${esc(t.artwork)}')` : ''}">${t.local && !t.artwork ? BULB : ''}</div>
        <div class="tt"><b title="${esc(t.title)}" data-notr>${esc(t.title)}</b>${artistHTML(t)}</div></div>
      <div class="note">${note}</div>
      <button class="add" title="Add to playlist">${ADD_ICON}</button>
      <button class="heart ${state.liked.has(t.id) ? 'on' : ''}" data-id="${esc(t.id)}" title="Like">${HEART}</button>
      <div class="dur">${t.offline ? '<span class="saved" title="Saved on this PC — plays without internet">⬇</span>' : ''}${fmt(t.durationMs / 1000)}</div>
    </div>`;
}

/** Shared click handling for track rows in a list whose tracks are `list.tracks`. */
function onRowClick(e, list) {
  const row = e.target.closest('.row');
  if (!row || !list) return;
  const i = Number(row.dataset.index), track = list.tracks[i];
  if (!track) return;
  if (e.target.closest('.heart')) return toggleLike(track);
  if (e.target.closest('.artist-link')) return showArtist(track);
  if (e.target.closest('.reopen')) return reopenCreation(track);
  if (e.target.closest('.add')) return openAddMenu(track, e.target.closest('.add'));
  const isCur = current()?.id === track.id && state.playlistId === list.id;
  if (isCur && !isDead(track.id)) toggle(); else startPlaylist(list, i, { retry: isDead(track.id) });
}

/** The artist under a song title: opens the uploader's artist page. Your own creations show "You · based on …". */
function artistHTML(t) {
  if (t.local) {
    const src = t.source?.title ? ` · <span class="from">${esc(tr('based on'))} <i data-notr>${esc(t.source.title)}</i></span>` : '';
    return `<span class="by-you">${esc(tr('You'))}${src}</span>`;
  }
  return `<span><button type="button" class="artist-link" data-notr title="${esc(tr('Show this artist'))}">${esc(t.artist)}</button></span>`;
}

/** Saved creations open in the mode they came from (DJ mixes on the decks, everything else in Studio). */
function reopenCreation(track) {
  showCreation(track, track.kind === 'dj' ? 'dj' : 'studio');
}

// ---------------------------------------------------------------- artist pages
let artistSeq = 0;
/** An artist page: the uploader's profile and public tracks, by their unique SoundCloud id. */
async function showArtist(track) {
  if (!track || track.local) return;
  leaveCreation();
  const seq = ++artistSeq;
  const data = { id: `artist:${track.userId || track.id}`, title: track.artist, tracks: [] };
  state.view = { kind: 'artist', id: data.id, data, from: track };
  for (const v of ['#composeView', '#playlistView', '#searchView']) $(v).classList.add('hidden');
  $('#artistView').classList.remove('hidden');
  renderNav();
  $('#main').scrollTop = 0;
  $('#arName').textContent = track.artist || track.uploader || '';
  $('#arSub').textContent = '';
  $('#arAvatar').style.backgroundImage = '';
  $('#arAvatar').classList.add('loading');
  $('#arOpen').classList.toggle('hidden', !track.userUrl); $('#arOpen').href = track.userUrl || '#';
  $('#arPlay').disabled = $('#arShuffle').disabled = true;
  $('#arAlias').classList.add('hidden');
  $('#arTracks').innerHTML = '';
  $('#arStatus').className = 'search-status';
  $('#arStatus').innerHTML = `<span class="spinner"></span> ${esc(tr('Loading this artist’s songs…'))}`;
  let r;
  try {
    r = await api('GET', track.userId ? `/api/artists/${encodeURIComponent(track.userId)}` : `/api/artists/by-track/${encodeURIComponent(track.id)}`);
  } catch (e) {
    if (seq !== artistSeq) return;
    $('#arAvatar').classList.remove('loading');
    $('#arStatus').className = 'search-status err';
    $('#arStatus').innerHTML = `${esc(tr('Couldn’t load this artist. Check your internet connection and try again.'))} <button class="chip-btn" id="arRetry">${esc(tr('Try again'))}</button><small class="small-note" data-notr>${esc(e.message)}</small>`;
    $('#arRetry').onclick = () => showArtist(track);
    return;
  }
  if (seq !== artistSeq) return;
  const u = r.user;
  data.id = state.view.id = `artist:${u.id}`;
  data.title = u.username;
  data.tracks = r.tracks;
  $('#arAvatar').classList.remove('loading');
  $('#arAvatar').style.backgroundImage = u.avatar ? `url('${u.avatar.replace(/'/g, '%27')}')` : '';
  $('#arName').textContent = u.username;
  const where = [u.city, u.country].filter(Boolean).join(', ');
  $('#arSub').innerHTML = [
    u.fullName && u.fullName !== u.username ? `<span data-notr>${esc(u.fullName)}</span>` : '',
    where ? `<span data-notr>${esc(where)}</span>` : '',
    `<span>${esc(tr('{n} followers').replace('{n}', Number(u.followers || 0).toLocaleString()))}</span>`,
  ].filter(Boolean).join(' · ');
  $('#arOpen').href = u.url || track.userUrl || '#'; $('#arOpen').classList.toggle('hidden', !(u.url || track.userUrl));
  // the song's credited artist can differ from the account that uploaded it (labels, channels, re-uploads)
  if (track.artist && track.artist.toLowerCase() !== u.username.toLowerCase()) {
    $('#arAlias').classList.remove('hidden');
    $('#arAlias').innerHTML = `<span>${esc(tr('Credited artist:'))}</span> <b data-notr>${esc(track.artist)}</b> <span>${esc(tr('(this account uploaded the song)'))}</span> <button class="chip-btn" id="arAliasSearch">${esc(tr('Search for this name'))}</button>`;
    $('#arAliasSearch').onclick = () => { $('#searchInput').value = track.artist; showSearch(track.artist, { artist: track.artist }); };
  }
  $('#arPlay').disabled = $('#arShuffle').disabled = !data.tracks.length;
  $('#arStatus').textContent = data.tracks.length ? '' : tr('This artist has no public songs that can be played here.');
  $('#arTracks').innerHTML = data.tracks.map((t, i) => rowHTML(t, i)).join('');
  renderTrackHighlight();
}
$('#arTracks').addEventListener('click', (e) => onRowClick(e, state.view.data));
$('#arPlay').addEventListener('click', () => { const pl = state.view.data; if (state.playlistId === pl.id && current()) toggle(); else startPlaylist(pl, 0, { shuffle: false }); });
$('#arShuffle').addEventListener('click', () => { const pl = state.view.data; startPlaylist(pl, Math.floor(Math.random() * pl.tracks.length), { shuffle: true }); });
const openNpArtist = () => { const t = current(); if (t && !t.local) showArtist(t); };
$('#npArtist').addEventListener('click', (e) => { e.preventDefault(); openNpArtist(); });
$('#npArtist').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNpArtist(); } });

// ---------------------------------------------------------------- drag and drop (playlist order)
let drag = null;
const trackListEl = $('#trackList');
const clearDrop = () => trackListEl.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
trackListEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.row[draggable="true"]');
  if (!row || state.view.kind !== 'playlist') return;
  drag = { id: row.dataset.id, list: state.view.data };
  row.classList.add('dragging');
  trackListEl.classList.add('reordering');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.id);
});
trackListEl.addEventListener('dragover', (e) => {
  if (!drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // keep scrolling while dragging near the top/bottom edge
  const main = $('#main'), mr = main.getBoundingClientRect();
  if (e.clientY < mr.top + 60) main.scrollTop -= 14; else if (e.clientY > mr.bottom - 60) main.scrollTop += 14;
  const row = e.target.closest('.row');
  if (!row || row.dataset.id === drag.id) { if (row) clearDrop(); return; }
  const r = row.getBoundingClientRect(), cls = e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after';
  if (!row.classList.contains(cls)) { clearDrop(); row.classList.add(cls); }
});
// Chromium often reports no relatedTarget on dragleave, so only clear when the pointer really left the list
trackListEl.addEventListener('dragleave', (e) => {
  if (!drag) return;
  const r = trackListEl.getBoundingClientRect();
  if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) clearDrop();
});
/** Where a drop at clientY lands: the row under the pointer, before or after it. */
function dropSpot(e) {
  const marked = trackListEl.querySelector('.drop-before, .drop-after');
  const row = e.target.closest?.('.row') || marked;
  if (!row || row.dataset.id === drag.id) return null;
  const r = row.getBoundingClientRect();
  return { id: row.dataset.id, after: e.clientY ? e.clientY >= r.top + r.height / 2 : row.classList.contains('drop-after') };
}
trackListEl.addEventListener('drop', (e) => {
  if (!drag) return;
  e.preventDefault();
  const spot = dropSpot(e);
  const { id, list } = drag;
  clearDrop();
  if (!spot || list !== state.view.data) return;
  const ids = list.tracks.map((t) => t.id).filter((x) => x !== id);
  let at = ids.indexOf(spot.id);
  if (at < 0) return;
  if (spot.after) at++;
  ids.splice(at, 0, id);
  applyOrder(list, ids);
});
trackListEl.addEventListener('dragend', () => {
  drag = null; clearDrop();
  trackListEl.classList.remove('reordering');
  trackListEl.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
});

/** New order: shown at once, followed by the play queue, then saved. */
async function applyOrder(pl, ids) {
  const before = pl.tracks.map((t) => t.id);
  if (before.join() === ids.join()) return;
  const byId = new Map(pl.tracks.map((t) => [t.id, t]));
  pl.tracks = ids.map((id) => byId.get(id)).filter(Boolean);
  renderPlaylist(pl);
  syncQueue(pl);
  try {
    await api('PUT', `/api/playlists/${encodeURIComponent(pl.id)}/order`, { ids });
    libCache = null;
  } catch (e) {
    toast(tr('Couldn’t save the new order') + ` (${e.message})`, true);
    pl.tracks = before.map((id) => byId.get(id)).filter(Boolean);
    if (state.view.data === pl) renderPlaylist(pl);
    syncQueue(pl);
  }
}

/** If this playlist is playing, the queue takes the new order; the current song keeps playing. */
function syncQueue(pl) {
  if (state.playlistId !== pl.id || !state.queue.length) return;
  const cur = current();
  const old = state.queue;
  const queue = pl.tracks.map((t) => ({ ...t }));
  const idx = new Map(queue.map((t, i) => [t.id, i]));
  if (state.shuffle) {
    // shuffled play keeps its own sequence; only the indices move
    const order = state.order.map((i) => idx.get(old[i]?.id)).filter((i) => i != null);
    for (const i of queue.keys()) if (!order.includes(i)) order.push(i);
    state.order = order;
  } else {
    state.order = [...queue.keys()];
  }
  state.queue = queue;
  const p = cur ? state.order.indexOf(idx.get(cur.id)) : -1;
  state.pos = p >= 0 ? p : Math.min(state.pos, state.order.length - 1);
  renderTrackHighlight(); reportState();
  if (state.playing) schedulePrecache();
}

// ---------------------------------------------------------------- add to playlist
function closeAddMenu() { $('#addMenu').classList.add('hidden'); $('#addMenu').innerHTML = ''; }
function openAddMenu(track, anchor) {
  const menu = $('#addMenu');
  const lists = state.playlists.filter((p) => !p.builtin);
  menu.innerHTML = `<div class="am-head">Add to playlist</div>
    <button data-add="liked">${HEART}<span>Liked Songs</span></button>
    ${lists.map((p) => `<button data-add="${esc(p.id)}">${NOTE}<span data-notr>${esc(p.title)}</span></button>`).join('')}
    <form class="am-new"><input placeholder="New playlist name" maxlength="80"><button class="primary" type="submit">Save</button></form>`;
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  const { liked: _l, offline: _o, ...meta } = track;
  menu.onclick = async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    closeAddMenu();
    try {
      if (b.dataset.add === 'liked') { if (!state.liked.has(track.id)) await toggleLike(track); else toast('Already in Liked Songs'); return; }
      const pl = state.playlists.find((p) => p.id === b.dataset.add);
      const { added } = await api('POST', `/api/playlists/${encodeURIComponent(b.dataset.add)}/tracks`, { track: meta });
      toast(added ? `Added to “${pl?.title}”` : `Already in “${pl?.title}”`);
      await loadPlaylists();
      if (state.view.kind === 'playlist' && state.view.id === b.dataset.add) showPlaylist(b.dataset.add, { silent: true });
    } catch (err) { toast(err.message, true); }
  };
  menu.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const name = menu.querySelector('input').value.trim();
    if (!name) return menu.querySelector('input').focus();
    closeAddMenu();
    try {
      const pl = await api('POST', '/api/playlists', { trackIds: [track.id], title: name });
      toast(`Created playlist “${pl.title}”`);
      await loadPlaylists();
    } catch (err) { toast(err.message, true); }
  };
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#addMenu') && !e.target.closest('.add')) closeAddMenu(); });

// ---------------------------------------------------------------- search
let searchSeq = 0, libCache = null;
async function cachedLibrary() {
  if (!libCache || Date.now() - libCache.at > 30000) libCache = { at: Date.now(), tracks: await libraryTracks() };
  return libCache.tracks;
}
async function showSearch(q, { artist = '' } = {}) {
  q = q.trim();
  if (!q) return;
  leaveCreation();
  const seq = ++searchSeq;
  const data = { id: `search:${artist || q}`, title: artist || q, tracks: [] };
  state.view = { kind: 'search', id: data.id, data };
  $('#composeView').classList.add('hidden'); $('#playlistView').classList.add('hidden'); $('#artistView').classList.add('hidden');
  $('#searchView').classList.remove('hidden');
  renderNav();
  $('#searchTitle').textContent = artist || `“${q}”`;
  $('#searchStatus').textContent = tr('Searching…');
  $('#searchLib').innerHTML = $('#searchSc').innerHTML = '';
  if (!artist) $('#searchArtists').innerHTML = '';
  $('#main').scrollTop = 0;

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const byArtist = (t) => [t.artist, t.uploader].some((a) => a && a.toLowerCase() === artist.toLowerCase());
  const matches = (t) => (artist ? byArtist(t) : words.every((w) => `${t.title} ${t.artist} ${t.uploader || ''}`.toLowerCase().includes(w)));
  const lib = (await cachedLibrary().catch(() => [])).filter(matches).slice(0, 30);
  if (seq !== searchSeq) return;
  const draw = (sc) => {
    data.tracks = [...lib, ...sc];
    $('#searchLibGroup').classList.toggle('hidden', !lib.length);
    $('#searchScGroup').classList.toggle('hidden', !sc.length);
    $('#searchLib').innerHTML = lib.map((t, i) => rowHTML(t, i)).join('');
    $('#searchSc').innerHTML = sc.map((t, i) => rowHTML(t, lib.length + i, i + 1)).join('');
    renderTrackHighlight();
  };
  draw([]);
  let sc = [];
  try { sc = await api('GET', `/api/search?q=${encodeURIComponent(artist || q)}&limit=50`); }
  catch (e) { if (seq === searchSeq) $('#searchStatus').textContent = e.message; }
  if (seq !== searchSeq) return;
  const libIds = new Set(lib.map((t) => t.id));
  sc = sc.filter((t) => !libIds.has(t.id) && (!artist || byArtist(t)));
  draw(sc);
  $('#searchStatus').textContent = lib.length + sc.length ? '' : tr('No songs found. Try a different spelling or fewer words.');
  if (!artist) {
    // artists that match the search (or appear a lot in the results), for "everything by this artist"
    const counts = new Map();
    for (const t of sc) counts.set(t.artist, (counts.get(t.artist) || 0) + 1);
    const top = [...counts].filter(([a, n]) => n > 1 || words.some((w) => a.toLowerCase().includes(w))).sort((a, b) => b[1] - a[1]).slice(0, 8);
    $('#searchArtists').innerHTML = top.length ? `<span class="sa-label">Artists</span>${top.map(([a]) => `<button class="chip-a" data-artist="${esc(a)}"><span data-notr>${esc(a)}</span></button>`).join('')}` : '';
  }
}
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); showSearch($('#searchInput').value); });
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length >= 2) searchTimer = setTimeout(() => showSearch(q), 450);
});
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); } });
$('#searchArtists').addEventListener('click', (e) => { const b = e.target.closest('[data-artist]'); if (b) showSearch($('#searchInput').value || b.dataset.artist, { artist: b.dataset.artist }); });
$('#searchView').addEventListener('click', (e) => { if (e.target.closest('.row')) onRowClick(e, state.view.data); });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !document.body.classList.contains('creating')) { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); } });

function renderTrackHighlight() {
  const cur = current();
  const sameList = state.view.data && state.view.data.id === state.playlistId;
  document.querySelectorAll('.row').forEach((r) => r.classList.toggle('current', !!(cur && sameList && r.dataset.id === cur.id)));
  document.querySelectorAll('.tracks').forEach((l) => l.classList.toggle('paused', !state.playing));
}

function renderNowPlaying() {
  const t = current();
  $('#npTitle').toggleAttribute('data-notr', !!t); $('#npArtist').setAttribute('data-notr', '');
  $('#npTitle').textContent = t ? t.title : 'Nothing playing';
  const npa = $('#npArtist');
  npa.textContent = t ? (t.local ? tr('You') : t.artist) : '';
  npa.classList.toggle('clickable', !!t && !t.local);
  npa.title = t && !t.local ? tr('Show this artist') : '';
  $('#scLink').href = t?.permalinkUrl || 'https://soundcloud.com';
  $('#scLink').classList.toggle('hidden', !!t?.local);
  $('#npArt').style.backgroundImage = t?.artwork ? `url('${t.artwork}')` : '';
  const like = $('#npLike');
  like.disabled = !t; like.dataset.id = t?.id || '';
  like.classList.toggle('on', !!t && state.liked.has(t.id));
  document.title = t ? `${t.title} · ${t.artist}` : 'Mixtape';
  if ('mediaSession' in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: state.playlistTitle, artwork: t.artwork ? [{ src: t.artwork, sizes: '500x500' }] : [] });
  }
}

function onPlayState(playing) {
  state.playing = playing;
  $('#playBtn').classList.toggle('playing', playing);
  $('#trackList').classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  reportState();
}

function setLoading(on) { $('#playBtn').classList.toggle('loading', on); }

let seeking = false;
function onTime() {
  if (seeking) return;
  const d = player.duration, p = player.position;
  $('#curTime').textContent = fmt(p); $('#durTime').textContent = fmt(d);
  const bar = $('#seekBar');
  bar.value = d ? Math.round((p / d) * 1000) : 0;
  bar.style.setProperty('--p', `${bar.value / 10}%`);
}

function renderModes() {
  $('#shuffleBtn').classList.toggle('on', state.shuffle);
  const r = $('#repeatBtn');
  r.classList.toggle('on', state.repeat !== 'off'); r.classList.toggle('one-mode', state.repeat === 'one');
  r.title = `Repeat: ${state.repeat}`;
}

function renderVolume() { const v = $('#volBar'); v.value = Math.round(state.volume * 100); v.style.setProperty('--p', `${v.value}%`); }

// ---------------------------------------------------------------- views
async function loadPlaylists() {
  state.playlists = await api('GET', '/api/playlists');
  const liked = await api('GET', '/api/playlists/liked');
  state.liked = new Set(liked.tracks.map((t) => t.id));
  renderNav();
}

async function showPlaylist(id, { silent } = {}) {
  try {
    const pl = await api('GET', `/api/playlists/${encodeURIComponent(id)}`);
    leaveCreation();
    $('#searchView').classList.add('hidden'); $('#artistView').classList.add('hidden');
    state.view = { kind: 'playlist', id, data: pl };
    $('#composeView').classList.add('hidden'); $('#playlistView').classList.remove('hidden');
    renderPlaylist(pl); renderNav();
    if (!silent) $('#main').scrollTop = 0;
    return pl;
  } catch (e) { toast(e.message, true); showCompose(); }
}

function showCompose() {
  leaveCreation();
  $('#searchView').classList.add('hidden'); $('#artistView').classList.add('hidden');
  state.view = { kind: 'compose', id: null, data: null };
  $('#playlistView').classList.add('hidden'); $('#composeView').classList.remove('hidden');
  renderNav();
  $('#promptInput').focus();
}

function offlineText(o) {
  if (!o.liked) return '';
  const busy = o.downloading.length + o.queued;
  const fails = Object.keys(o.failed || {}).length;
  return `⬇ ${o.saved} of ${o.liked} saved on this PC (${o.megabytes} MB)` + (busy ? ` · saving ${busy} more…` : '') + (fails ? ` · ${fails} couldn't be saved, will retry` : '');
}

// ---------------------------------------------------------------- Creation Mode
let creation = null;
function leaveCreation() {
  if (!creation) return;
  creation.closeCreation();
  $('#createView').classList.add('hidden'); $('#createView').innerHTML = '';
  $('#createBtn').classList.remove('active'); $('#singBtn').classList.remove('active');
  document.body.classList.remove('creating');
}
async function libraryTracks() {
  const seen = new Set(), out = [];
  if (current()) { out.push(current()); seen.add(current().id); }
  for (const p of state.playlists) {
    const pl = await api('GET', `/api/playlists/${encodeURIComponent(p.id)}`).catch(() => null);
    for (const t of pl?.tracks || []) if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
  }
  return out;
}
async function showCreation(track = current() || state.view.data?.tracks?.[0] || null, tab) {
  creation ??= await import('/create/index.js');
  state.view = { kind: 'create', id: null, data: null };
  $('#composeView').classList.add('hidden'); $('#playlistView').classList.add('hidden'); $('#searchView').classList.add('hidden'); $('#artistView').classList.add('hidden');
  const view = $('#createView');
  view.classList.remove('hidden');
  const markTab = (t) => { $('#createBtn').classList.toggle('active', t !== 'sing'); $('#singBtn').classList.toggle('active', t === 'sing'); };
  markTab(tab || 'studio');
  document.body.classList.add('creating');
  renderNav();
  $('#main').scrollTop = 0;
  await creation.openCreation(view, {
    track,
    toast,
    pausePlayer: () => { if (!player.paused) player.pause(); },
    libraryTracks,
    search: (q) => api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=20`),
    onTab: markTab,
  }, { tab, track });
}

// ---------------------------------------------------------------- generation
const CHIPS = ['late-night drive, dark synthwave', 'sunny afternoon funk & disco edits', 'deep focus ambient techno', 'melancholic indie bedroom pop', 'Afrobeats & amapiano party', 'jazzy lo-fi for reading', 'UK garage & 2-step', 'heavy liquid drum & bass'];
let generating = false;
let awaitingDefaults = false;

async function generate(prompt) {
  if (generating) return;
  prompt = prompt.trim();
  if (!prompt) { $('#promptInput').focus(); return; }
  generating = true;
  showCompose();
  $('#promptInput').value = prompt;
  const box = $('#progress'), log = $('#progressLog');
  box.classList.remove('hidden', 'error'); log.innerHTML = '';
  $('#progressTitle').textContent = 'Curating your mix…';
  $('#generateBtn').disabled = true;
  const add = (m) => { const li = document.createElement('li'); li.textContent = m; log.appendChild(li); log.scrollTop = log.scrollHeight; };
  try {
    const res = await fetch('/api/playlists/generate', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ prompt }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1], data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || '{}');
        if (ev === 'progress') add(data.message);
        if (ev === 'error') throw new Error(data.message);
        if (ev === 'done') result = data;
      }
    }
    if (!result) throw new Error('Generation ended unexpectedly');
    result.warnings?.forEach((w) => toast(w));
    box.classList.add('hidden');
    $('#promptInput').value = '';
    await loadPlaylists();
    const pl = await showPlaylist(result.playlist.id);
    if (pl && !state.playing) startPlaylist(pl, 0);
  } catch (e) {
    box.classList.add('error');
    $('#progressTitle').textContent = 'Something went wrong';
    add(e.message);
  } finally {
    generating = false; $('#generateBtn').disabled = false;
  }
}

// ---------------------------------------------------------------- settings
const dlg = $('#settings');
// Quick-setup presets for Custom API (all editable afterwards)
const API_PRESETS = [
  { id: 'custom', label: 'Custom…' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', format: 'openai', model: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com', format: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', format: 'openai', model: '' },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', format: 'openai', model: 'deepseek-chat' },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', format: 'openai', model: '' },
  { id: 'ollama', label: 'Ollama (this PC)', url: 'http://localhost:11434/v1', format: 'openai', model: 'llama3.1' },
  { id: 'lmstudio', label: 'LM Studio (this PC)', url: 'http://localhost:1234/v1', format: 'openai', model: '' },
];
let settingsCfg = null;
async function openSettings() {
  const { config } = await api('GET', '/api/config');
  settingsCfg = config;
  const f = $('#settingsForm');
  $('#langSelect').innerHTML = LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === currentLanguage() ? 'selected' : ''}>${l.label}</option>`).join('');
  $('#apiPreset').innerHTML = API_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  const custom = config.llm.provider === 'openai' || config.llm.provider === 'anthropic';
  f.querySelector(`input[name=provider][value="${custom ? 'custom' : 'claude-cli'}"]`).checked = true;
  for (const el of f.querySelectorAll('input[name*="."]')) {
    const [a, b] = el.name.split('.');
    el.value = (a === 'soundcloud' ? config.soundcloud[b] : config.llm[a]?.[b]) || '';
  }
  fillCustom(config.llm.provider === 'anthropic' ? 'anthropic' : 'openai');
  const match = API_PRESETS.find((p) => p.url && p.url === $('#apiUrl').value.replace(/\/+$/, ''));
  $('#apiPreset').value = match?.id || 'custom';
  api('GET', '/api/create/engine').then(renderGpuStatus).catch(() => {});
  showProviderFields(); $('#testResult').textContent = '';
  dlg.showModal();
}
/** Show the stored endpoint/model/key for one API format. */
function fillCustom(format) {
  const c = settingsCfg.llm[format] || {};
  $('#apiFormat').value = format;
  $('#apiUrl').value = c.baseUrl || '';
  $('#apiModel').value = c.model || '';
  $('#apiKey').value = c.apiKey || '';
}
function showProviderFields() {
  const p = $('#settingsForm').querySelector('input[name=provider]:checked')?.value;
  document.querySelectorAll('.pfields').forEach((d) => d.classList.toggle('show', d.dataset.for === p));
}
async function saveSettings() {
  const f = $('#settingsForm');
  const choice = f.querySelector('input[name=provider]:checked').value;
  const format = $('#apiFormat').value;
  const body = { llm: { provider: choice === 'custom' ? format : 'claude-cli' }, soundcloud: {} };
  for (const el of f.querySelectorAll('input[name*="."]')) {
    const [a, b] = el.name.split('.');
    if (a === 'soundcloud') body.soundcloud[b] = el.value; else (body.llm[a] ??= {})[b] = el.value;
  }
  if (choice === 'custom') {
    const url = $('#apiUrl').value.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(tr('Enter a valid API endpoint URL, starting with http:// or https://'));
    body.llm[format] = { baseUrl: url, model: $('#apiModel').value.trim(), apiKey: $('#apiKey').value };
  }
  body.ui = { language: $('#langSelect').value };
  const r = await api('PUT', '/api/config', body);
  const gpuBody = { gpu: $('#aiDevice').value !== 'cpu' };
  if (!$('#aiGpuRow').classList.contains('hidden')) gpuBody.deviceId = $('#aiGpuSel').value === '' ? null : Number($('#aiGpuSel').value);
  await api('POST', '/api/create/engine/gpu', gpuBody).catch(() => {});
  settingsCfg = r.config;
  renderLlmStatus(r);
  return r;
}
/** Settings → Creation Mode: which device the song-splitting AI uses, and why. */
function renderGpuStatus(st) {
  $('#aiDevice').value = st.gpu === false ? 'cpu' : 'auto';
  const row = $('#aiGpuRow'), sel = $('#aiGpuSel'), box = $('#aiGpuStatus');
  const many = (st.adapters || []).length > 1;
  row.classList.toggle('hidden', !many || st.gpu === false);
  if (many) {
    sel.innerHTML = `<option value="">${esc(tr('Automatic (fastest)'))}</option>` + st.adapters.map((n, i) => `<option value="${i}" data-notr>${esc(n)}</option>`).join('');
    sel.value = st.gpuDeviceId == null ? '' : String(st.gpuDeviceId);
  }
  const line = (cls, label, text) => `<p class="${cls}"><b>${esc(tr(label))}</b> <span data-notr>${esc(text || '')}</span></p>`;
  const states = {
    ok: () => line('ok', 'Now using: graphics card', st.deviceName),
    untested: () => line('', 'Graphics card: will be tried the next time a song is split', (st.adapters || []).join(', ')),
    retry: () => line('warn', 'Graphics card: will be tried again', ''),
    failed: () => line('warn', 'Now using: processor (the graphics card failed this time)', ''),
    disabled: () => line('err', 'Graphics card switched off after repeated failures', ''),
    off: () => line('', 'Now using: processor (your choice)', ''),
    unsupported: () => line('', 'Graphics card acceleration is only available on Windows', ''),
  };
  box.innerHTML = (states[st.gpuState] || states.untested)()
    + (st.gpuMessage && st.gpuState !== 'ok' && st.gpuState !== 'off' ? `<p class="small-note">${esc(tr(st.gpuMessage))}</p>` : '')
    + (st.gpuError && st.gpuState !== 'ok' && st.gpuState !== 'off' ? `<details class="small-note"><summary>${esc(tr('Technical details'))}</summary><code data-notr>${esc(st.gpuError)}</code></details>` : '')
    + (['failed', 'disabled', 'retry'].includes(st.gpuState) ? `<button type="button" class="chip-btn" id="aiGpuReset">${esc(tr('Try graphics card again'))}</button>` : '');
  $('#aiGpuReset')?.addEventListener('click', async () => renderGpuStatus(await api('POST', '/api/create/engine/gpu', { reset: true })));
}
async function refreshLlmStatus() { try { renderLlmStatus(await api('GET', '/api/config')); } catch { /* ignore */ } }
function renderLlmStatus(r) {
  $('#llmDot').className = 'dot ' + (r.llmError ? 'err' : 'ok');
  $('#llmLabel').textContent = r.llm || r.llmError || 'Settings';
}

// ---------------------------------------------------------------- remote control & state reporting
let reportTimer;
function reportState() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    const t = current();
    api('POST', '/api/player/state', {
      playing: state.playing, position: player.position, index: state.order[state.pos] ?? null,
      playlistId: state.playlistId, playlistTitle: state.playlistTitle,
      shuffle: state.shuffle, repeat: state.repeat, volume: state.volume,
      track: t ? { id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, permalinkUrl: t.permalinkUrl, liked: state.liked.has(t.id) } : null,
    }).catch(() => {});
  }, 150);
}
setInterval(() => { if (state.playing) reportState(); }, 5000);

async function handleCommand(c) {
  switch (c.action) {
    case 'play': {
      const pl = await showPlaylist(c.playlistId);
      if (pl) startPlaylist(pl, c.index || 0, { shuffle: !!c.shuffle });
      break;
    }
    case 'pause': player.pause(); break;
    case 'resume': if (current()) player.play(); else toggle(); break;
    case 'toggle': toggle(); break;
    case 'next': next(); break;
    case 'previous': prev(); break;
    case 'shuffle': setShuffle(c.value === undefined ? !state.shuffle : c.value === true || c.value === 'true' || c.value === 'on'); break;
    case 'repeat': setRepeat(['off', 'all', 'one'].includes(c.value) ? c.value : undefined); break;
    case 'volume': player.setVolume(Math.max(0, Math.min(1, Number(c.value) / 100))); break;
    case 'seek': player.seek(Number(c.value) || 0); break;
    case 'open': if (c.playlistId) showPlaylist(c.playlistId); break;
  }
  reportState();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('command', (e) => handleCommand(JSON.parse(e.data)));
  es.addEventListener('library', async () => {
    libCache = null;
    await loadPlaylists();
    // First run: switch to My Songs as soon as it has been built.
    if (awaitingDefaults && state.view.kind === 'compose' && !generating && !current() && state.playlists.some((p) => p.id === 'mine')) {
      awaitingDefaults = false; return showPlaylist('mine');
    }
    if (state.view.kind === 'playlist') showPlaylist(state.view.id, { silent: true });
  });
  // liked songs being saved to this PC: refresh the Liked view (throttled)
  let offTimer;
  es.addEventListener('offline', () => {
    clearTimeout(offTimer);
    offTimer = setTimeout(() => { if (state.view.kind === 'playlist' && state.view.id === 'liked') showPlaylist('liked', { silent: true }); }, 400);
  });
  es.addEventListener('liked', (e) => { const d = JSON.parse(e.data); if (state.liked.has(d.trackId) !== d.liked) setLikedLocal(d.trackId, d.liked); });
  es.addEventListener('hello', () => reportState());
}

// ---------------------------------------------------------------- wiring
$('#chips').innerHTML = CHIPS.map((c) => `<button type="button">${esc(c)}</button>`).join('');
$('#chips').addEventListener('click', (e) => { if (e.target.matches('button')) { $('#promptInput').value = e.target.textContent; $('#promptInput').focus(); } });
$('#composeForm').addEventListener('submit', (e) => { e.preventDefault(); generate($('#promptInput').value); });
$('#promptInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(e.target.value); } });
$('#newMixBtn').addEventListener('click', showCompose);
$('#createBtn').addEventListener('click', () => showCreation(undefined, 'studio'));
$('#singBtn').addEventListener('click', () => showCreation(undefined, 'sing'));
$('#npCreate').addEventListener('click', () => current() && showCreation(current(), 'studio'));
$('#inspGo').addEventListener('click', () => showCreation(undefined, 'studio'));
$('#playlistNav').addEventListener('click', (e) => { const b = e.target.closest('[data-pl]'); if (b) showPlaylist(b.dataset.pl); });

$('#trackList').addEventListener('click', (e) => onRowClick(e, state.view.data));
$('#plPlay').addEventListener('click', () => {
  const pl = state.view.data;
  if (state.playlistId === pl.id && current()) toggle(); else startPlaylist(pl, 0, { shuffle: false });
});
$('#plShuffle').addEventListener('click', () => { const pl = state.view.data; startPlaylist(pl, Math.floor(Math.random() * pl.tracks.length), { shuffle: true }); });
$('#plRegen').addEventListener('click', () => {
  const pl = state.view.data;
  if (pl.id === 'for-you' || pl.id === 'mine') refreshBuiltin(pl.id);
  else generate(pl.prompt);
});

async function readSse(res, onProgress) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk)?.[1], data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || '{}');
      if (ev === 'progress') onProgress(data.message);
      if (ev === 'error') throw new Error(data.message);
      if (ev === 'done') result = data;
    }
  }
  if (!result) throw new Error('Ended unexpectedly');
  return result;
}

let refreshing = false;
async function refreshBuiltin(id) {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#plRegen'); btn.disabled = true;
  const label = btn.lastChild.textContent;
  toast(id === 'for-you' ? 'Finding new recommendations…' : 'Matching your songs on SoundCloud…');
  try {
    const res = await fetch(`/api/builtin/${id}/refresh`, { method: 'POST', headers: { accept: 'text/event-stream' } });
    await readSse(res, (m) => { btn.lastChild.textContent = m.length > 28 ? m.slice(0, 27) + '…' : m; });
    await loadPlaylists();
    if (state.view.id === id) await showPlaylist(id, { silent: true });
    toast(id === 'for-you' ? 'For You refreshed' : 'My Songs updated');
  } catch (e) { toast(e.message, true); }
  finally { refreshing = false; btn.disabled = false; btn.lastChild.textContent = label; if (state.view.id === id) renderPlaylist(state.view.data); }
}
$('#plDelete').addEventListener('click', async () => {
  const pl = state.view.data;
  if (!confirm(`Delete “${pl.title}”? Liked songs stay in Liked Songs.`)) return;
  await api('DELETE', `/api/playlists/${pl.id}`);
  await loadPlaylists(); showCompose();
});
$('#plTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('#plTitle').addEventListener('blur', async (e) => {
  const pl = state.view.data, title = e.target.textContent.trim();
  if (!pl || pl.id === 'liked' || !title || title === pl.title) { e.target.textContent = pl?.title || ''; return; }
  await api('PATCH', `/api/playlists/${pl.id}`, { title }); pl.title = title;
  if (state.playlistId === pl.id) state.playlistTitle = title;
  loadPlaylists();
});

$('#playBtn').addEventListener('click', toggle);
$('#nextBtn').addEventListener('click', () => next());
$('#prevBtn').addEventListener('click', prev);
$('#shuffleBtn').addEventListener('click', () => setShuffle(!state.shuffle));
$('#repeatBtn').addEventListener('click', () => setRepeat());
$('#npLike').addEventListener('click', () => toggleLike(current()));
const seekBar = $('#seekBar');
seekBar.addEventListener('input', () => { seeking = true; seekBar.style.setProperty('--p', `${seekBar.value / 10}%`); $('#curTime').textContent = fmt(seekBar.value / 1000 * player.duration); });
seekBar.addEventListener('change', () => { player.seek(seekBar.value / 1000 * player.duration); seeking = false; reportState(); });
$('#volBar').addEventListener('input', (e) => player.setVolume(e.target.value / 100));

$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsForm').addEventListener('change', (e) => {
  if (e.target.name === 'provider') showProviderFields();
  if (e.target.id === 'apiFormat') fillCustom(e.target.value);
  if (e.target.id === 'apiPreset') {
    const p = API_PRESETS.find((x) => x.id === e.target.value);
    if (p?.url) { fillCustom(p.format); $('#apiUrl').value = p.url; if (p.model || !$('#apiModel').value) $('#apiModel').value = p.model; }
  }
  if (e.target.id === 'langSelect') { setLanguage(e.target.value); api('PUT', '/api/config', { ui: { language: e.target.value } }).catch(() => {}); }
});
$('#saveSettings').addEventListener('click', async () => { try { await saveSettings(); dlg.close(); toast('Settings saved'); } catch (e) { toast(e.message, true); } });
$('#testLlm').addEventListener('click', async () => {
  const out = $('#testResult');
  out.className = 'test-result'; out.textContent = 'Testing…';
  try {
    await saveSettings();
    const r = await api('POST', '/api/llm/test');
    out.className = 'test-result ok'; out.textContent = `✓ ${r.provider} replied “${r.reply}” in ${(r.ms / 1000).toFixed(1)}s`;
  } catch (e) { out.className = 'test-result err'; out.textContent = `✗ ${e.message}`; }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, [contenteditable="true"], dialog') || document.body.classList.contains('creating')) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
  else if (e.key === 'ArrowRight') player.seek(player.position + 5);
  else if (e.key === 'ArrowLeft') player.seek(player.position - 5);
  else if (e.key.toLowerCase() === 'l') toggleLike(current());
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => player.play());
  ms.setActionHandler('pause', () => player.pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', prev);
  try { ms.setActionHandler('seekto', (d) => player.seek(d.seekTime)); } catch { /* unsupported */ }
}

// ---------------------------------------------------------------- boot
(async function boot() {
  // language: saved choice (or the system language) first so there's no English flash, then the app's setting
  await setLanguage(detectLanguage());
  api('GET', '/api/config').then(({ config }) => { const l = config.ui?.language; if (l && l !== currentLanguage()) setLanguage(l); }).catch(() => {});
  renderModes(); renderVolume(); audio.volume = state.volume;
  await loadPlaylists().catch((e) => toast(e.message, true));
  refreshLlmStatus();
  connectEvents();
  const q = new URLSearchParams(location.search);
  if (q.get('play')) {
    history.replaceState(null, '', '/');
    const pl = await showPlaylist(q.get('play'));
    if (pl) startPlaylist(pl, Number(q.get('index')) || 0, { shuffle: q.get('shuffle') === '1' });
  } else if (state.playlists.some((p) => p.id === 'mine')) {
    showPlaylist('mine');
  } else {
    showCompose();
    awaitingDefaults = true;
  }
})();
