// Local HTTP server: REST API, server-sent events, SoundCloud stream proxy, and the web player UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { publicConfig, saveConfig } from './config.js';
import { importMySongs, refreshForYou } from './seed.js';
import * as engine from './create/engine.js';
import { getFullAudio, cachedAudio } from './create/audio.js';
import crypto from 'node:crypto';
import { OfflineSync } from './offline.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export const APP_ID = 'mixtape-agent';

export function createServer(app) {
  const clients = new Set();          // SSE connections from player UIs
  let playerState = null;             // last state reported by a player UI
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
    return clients.size;
  };
  app.library.onChange(() => broadcast('library', { at: Date.now() }));
  const offline = new OfflineSync(app, (e) => broadcast('offline', e));
  app.offline = offline;
  app.library.onChange(() => offline.schedule());
  setTimeout(() => offline.schedule(0), 2000).unref?.(); // catch up on likes made while the app was closed

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  // ---- library -------------------------------------------------------------
  // ---- Creation Mode ------------------------------------------------------
  const sse = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  route('GET', '/api/create/engine', () => engine.status());
  route('POST', '/api/create/engine/gpu', ({ body }) => {
    if (body.reset) return engine.resetGpu();
    if ('deviceId' in body) engine.setGpuDevice(body.deviceId);
    return 'gpu' in body ? engine.setGpu(body.gpu !== false) : engine.status();
  });
  route('POST', '/api/create/engine/install', async ({ res }) => {
    const send = sse(res);
    try { send('done', await engine.install((p) => send('progress', p))); } catch (e) { send('error', { message: e.message }); }
    res.end();
    return STREAMED;
  });
  // Whole song as one audio file (decoded in the app). Cached on disk.
  route('GET', '/api/create/audio/:id', async ({ params, res }) => {
    const a = await getFullAudio(app, params.id);
    const st = fs.statSync(a.file);
    res.writeHead(200, { 'content-type': a.mime, 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(a.file).pipe(res);
    return STREAMED;
  });
  route('GET', '/api/create/stems/:id', ({ params }) => {
    const meta = engine.cachedStems(params.id);
    return meta ? { ready: true, ...meta, urls: Object.fromEntries(meta.stems.map((s) => [s, `/api/create/stems/${encodeURIComponent(params.id)}/${s}.wav`])) } : { ready: false };
  });
  route('GET', '/api/create/stems/:id/:file', ({ params, res }) => {
    const stem = params.file.replace(/\.wav$/, '');
    if (!engine.STEMS.includes(stem)) httpError(404, 'Unknown stem');
    const file = path.join(engine.stemDir(params.id), `${stem}.wav`);
    if (!fs.existsSync(file)) httpError(404, 'Not split yet');
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': fs.statSync(file).size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return STREAMED;
  });
  // Body: Int16 stereo interleaved PCM at 44.1 kHz. Streams progress, then the stem URLs.
  route('POST', '/api/create/separate/:id', async ({ params, req, res }) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 400e6) httpError(413, 'Song too long'); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    const send = sse(res);
    try {
      const meta = await engine.separate(params.id, pcm, (p) => send('progress', p));
      send('done', { ...meta, urls: Object.fromEntries(meta.stems.map((s) => [s, `/api/create/stems/${encodeURIComponent(params.id)}/${s}.wav`])) });
    } catch (e) { send('error', { message: e.message }); }
    res.end();
    return STREAMED;
  });

  route('GET', '/api/health', () => ({ ok: true, app: APP_ID, players: clients.size }));
  route('GET', '/api/playlists', () => app.library.listPlaylists());
  route('GET', '/api/playlists/:id', ({ params }) => {
    const pl = app.library.getPlaylist(params.id) || httpError(404, 'Playlist not found');
    pl.tracks = pl.tracks.map((t) => ({ ...t, offline: t.liked && offline.has(t.id) }));
    if (params.id === 'liked') pl.offline = offline.status();
    return pl;
  });
  route('GET', '/api/offline', () => offline.status());
  // Is SoundCloud reachable at all? (tells "this song is broken" apart from "the internet is down")
  route('GET', '/api/net', async () => {
    try { await Promise.race([app.sc.searchTracks('music', { limit: 1 }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))]); return { online: true }; }
    catch (e) { return { online: false, error: e.message }; }
  });
  // Pre-cache upcoming songs so the next track starts instantly (kept in the rolling 30-song cache).
  const precaching = new Set();
  route('POST', '/api/precache', async ({ body }) => {
    const ids = (body.ids || []).map(String).slice(0, 3);
    const started = [], unavailable = [];
    // Preflight: make sure each upcoming song can actually be streamed, so the player can skip dead ones ahead of time.
    await Promise.all(ids.map(async (id) => {
      if (cachedAudio(id)) return;
      try { await app.sc.resolveStream(id); } catch { unavailable.push(id); return; }
      if (precaching.has(id)) return;
      precaching.add(id); started.push(id);
      getFullAudio(app, id).catch(() => {}).finally(() => precaching.delete(id));
    }));
    return { started, unavailable, cached: ids.filter((id) => cachedAudio(id)) };
  });
  // A liked song saved on this PC (supports seeking via Range requests)
  route('GET', '/api/offline/:id', ({ params, req, res }) => {
    const f = cachedAudio(params.id) || httpError(404, 'Not downloaded');
    const size = fs.statSync(f.file).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return STREAMED; }
      res.writeHead(206, { 'content-type': f.mime, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
      fs.createReadStream(f.file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': f.mime, 'content-length': size, 'accept-ranges': 'bytes' });
      fs.createReadStream(f.file).pipe(res);
    }
    return STREAMED;
  });
  route('PATCH', '/api/playlists/:id', ({ params, body }) => app.library.renamePlaylist(params.id, body.title));
  route('DELETE', '/api/playlists/:id', ({ params }) => { app.library.deletePlaylist(params.id); return { ok: true }; });
  route('POST', '/api/playlists/:id/tracks', ({ params, body }) => {
    const t = body.track;
    if (!t?.id || !t.title) httpError(400, 'track required');
    const added = app.library.addTrack(params.id, t);
    return { added };
  });
  route('DELETE', '/api/playlists/:id/tracks/:trackId', ({ params }) => {
    app.library.removeTrack(params.id, params.trackId);
    if (params.id === 'inspirations') { const f = cachedAudio(params.trackId, [engine.paths.inspirations()]); if (f) fs.rmSync(f.file, { force: true }); }
    return { ok: true };
  });
  // Drag-and-drop: the playlist's songs in their new order
  route('PUT', '/api/playlists/:id/order', ({ params, body }) => {
    if (!Array.isArray(body.ids)) httpError(400, 'ids required');
    return app.library.reorder(params.id, body.ids);
  });

  // ---- My Inspirations: versions saved in Creation Mode, kept on this PC --------
  // Body: the audio file (WAV from Studio/Mashup/Sing, WebM from DJ). Query: title, kind, sourceId/Title/Artist, durationMs.
  route('POST', '/api/inspirations', async ({ req, query }) => {
    const ext = query.get('ext') === 'webm' ? 'webm' : 'wav';
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 600e6) httpError(413, 'File too large'); chunks.push(c); }
    if (size < 64) httpError(400, 'Empty recording');
    const id = `insp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = engine.paths.inspirations();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${ext}`), Buffer.concat(chunks));
    const kind = ['studio', 'mashup', 'dj', 'sing'].includes(query.get('kind')) ? query.get('kind') : 'studio';
    const clip = (v, n = 200) => String(v || '').slice(0, n);
    const track = {
      id, local: true, kind, ext,
      title: clip(query.get('title')) || 'My creation',
      artist: 'You',
      artwork: clip(query.get('artwork'), 500),
      durationMs: Math.max(0, Number(query.get('durationMs')) || 0),
      source: { id: clip(query.get('sourceId'), 40), title: clip(query.get('sourceTitle')), artist: clip(query.get('sourceArtist')) },
      createdAt: new Date().toISOString(),
    };
    app.library.addInspiration(track);
    return track;
  });

  // ---- Artist pages: the uploader's profile and tracks, by their unique SoundCloud id -----
  const artistPage = async (userId) => {
    const liked = app.library.likedIds();
    const [user, tracks] = await Promise.all([app.sc.getUser(userId), app.sc.userTracks(userId, { limit: 50 })]);
    return { user, tracks: tracks.map(({ transcodings, trackAuthorization, ...t }) => ({ ...t, liked: liked.has(t.id) })) };
  };
  route('GET', '/api/artists/:userId', ({ params }) => artistPage(params.userId));
  route('GET', '/api/artists/by-track/:trackId', async ({ params }) => {
    const t = app.library.findTrack(params.trackId);
    const userId = t?.userId || (await app.sc.getTrack(params.trackId)).userId;
    if (!userId) httpError(404, 'Artist not found');
    return artistPage(userId);
  });

  // Create from explicit track ids (used when Claude, as host LLM, curates via MCP).
  route('POST', '/api/playlists', async ({ body }) => {
    if (!Array.isArray(body.trackIds) || !body.trackIds.length) httpError(400, 'trackIds required');
    return app.curator.createFromIds({ ids: body.trackIds, title: body.title, description: body.description, prompt: body.prompt, notes: body.notes || {} });
  });

  // Autonomous generation with the configured LLM. Streams progress as SSE when asked to.
  route('POST', '/api/playlists/generate', async ({ body, req, res }) => {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) httpError(400, 'prompt required');
    if (!(req.headers.accept || '').includes('text/event-stream')) {
      const r = await app.generate(prompt);
      return { playlist: r.playlist, warnings: r.warnings };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const r = await app.generate(prompt, { onProgress: (p) => send('progress', p) });
      send('done', { playlist: r.playlist, warnings: r.warnings });
    } catch (e) {
      send('error', { message: e.message });
    }
    res.end();
    return STREAMED;
  });

  // Built-in playlists: re-match My Songs, regenerate For You (SSE progress when requested).
  const sseJob = (job) => async ({ req, res }) => {
    if (!(req.headers.accept || '').includes('text/event-stream')) return job(() => {});
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try { send('done', await job((p) => send('progress', p))); } catch (e) { send('error', { message: e.message }); }
    res.end();
    return STREAMED;
  };
  route('POST', '/api/builtin/mine/refresh', sseJob((onProgress) => importMySongs(app, { onProgress })));
  route('POST', '/api/builtin/for-you/refresh', sseJob((onProgress) => refreshForYou(app, { onProgress })));

  route('POST', '/api/likes/:trackId', ({ params, body }) => {
    const id = params.trackId;
    const track = body.track || app.library.findTrack(id) || app.sc.trackCache.get(String(id)) || null;
    const liked = typeof body.liked === 'boolean' ? app.library.setLiked(id, body.liked, track) : app.library.toggleLiked(id, track);
    broadcast('liked', { trackId: String(id), liked });
    return { trackId: String(id), liked };
  });

  // ---- SoundCloud search + playback --------------------------------------
  route('GET', '/api/search', async ({ query }) => {
    const q = query.get('q');
    if (!q) httpError(400, 'q required');
    const liked = app.library.likedIds();
    return (await app.sc.searchTracks(q, { limit: Math.min(Number(query.get('limit')) || 30, 50) }))
      .map(({ transcodings, trackAuthorization, ...t }) => ({ ...t, liked: liked.has(t.id) }));
  });

  route('POST', '/api/search/multi', async ({ body }) => {
    const queries = (body.queries || []).map(String).filter(Boolean).slice(0, 12);
    if (!queries.length) httpError(400, 'queries required');
    const tracks = await app.curator.searchCandidates(queries, { perQuery: Math.min(body.perQuery || 30, 50) });
    return tracks.slice(0, body.limit || 80).map(({ transcodings, trackAuthorization, _score, ...t }) => t);
  });

  route('GET', '/api/stream/:id', async ({ params }) => {
    // Liked (saved) or pre-cached songs play straight from disk.
    const local = cachedAudio(params.id);
    if (local) return { kind: 'progressive', src: `/api/offline/${encodeURIComponent(params.id)}`, mime: local.mime, offline: offline.has(params.id), local: true };
    const s = await app.sc.resolveStream(params.id);
    const proxied = `/api/proxy?u=${encodeURIComponent(Buffer.from(s.url).toString('base64url'))}`;
    return s.protocol === 'hls'
      ? { kind: 'hls', src: `/api/hls/${encodeURIComponent(params.id)}.m3u8`, mime: s.mime }
      : { kind: 'progressive', src: proxied, mime: s.mime };
  });

  route('GET', '/api/hls/:file', async ({ params, res }) => {
    const id = params.file.replace(/\.m3u8$/, '');
    const s = await app.sc.resolveStream(id);
    if (s.protocol !== 'hls') httpError(400, 'Track is not HLS');
    const up = await fetch(s.url);
    if (!up.ok) httpError(502, `Upstream playlist ${up.status}`);
    const text = await up.text();
    const prox = (u) => `/api/proxy?u=${Buffer.from(new URL(u, s.url).href).toString('base64url')}`;
    const out = text.split('\n').map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prox(u)}"`);
      return prox(l);
    }).join('\n');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(out);
    return STREAMED;
  });

  route('GET', '/api/proxy', async ({ query, req, res }) => {
    let target;
    try { target = new URL(Buffer.from(query.get('u') || '', 'base64url').toString()); } catch { httpError(400, 'bad url'); }
    if (!/^https?:$/.test(target.protocol) || !app.allowedStreamHost(target.hostname)) httpError(403, 'Host not allowed');
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    const up = await fetch(target, { headers });
    const pass = { 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    for (const h of ['content-type', 'content-length', 'content-range']) { const v = up.headers.get(h); if (v) pass[h] = v; }
    res.writeHead(up.status, pass);
    if (!up.body) { res.end(); return STREAMED; }
    const stream = Readable.fromWeb(up.body);
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
    return STREAMED;
  });

  // ---- remote control (Claude -> MCP -> here -> player UI) ----------------
  route('GET', '/api/events', ({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return STREAMED;
  });
  route('POST', '/api/player/command', ({ body }) => {
    const allowed = ['play', 'pause', 'resume', 'toggle', 'next', 'previous', 'seek', 'volume', 'shuffle', 'repeat', 'open'];
    if (!allowed.includes(body.action)) httpError(400, `action must be one of ${allowed.join(', ')}`);
    const delivered = broadcast('command', body);
    return { delivered, state: playerState };
  });
  route('POST', '/api/player/state', ({ body }) => { playerState = { ...body, reportedAt: new Date().toISOString() }; return { ok: true }; });
  route('GET', '/api/player/state', () => ({ connected: clients.size > 0, state: playerState }));

  // ---- settings -----------------------------------------------------------
  route('GET', '/api/config', () => ({ config: publicConfig(app.cfg), llm: app.llm?.describe() || null, llmError: app.llmError }));
  route('PUT', '/api/config', ({ body }) => {
    const partial = { llm: {}, soundcloud: {} };
    const l = body.llm || {};
    if (l.provider) partial.llm.provider = l.provider;
    for (const prov of ['claudeCli', 'anthropic', 'openai']) {
      if (!l[prov]) continue;
      partial.llm[prov] = {};
      for (const k of ['model', 'baseUrl', 'command']) if (typeof l[prov][k] === 'string') partial.llm[prov][k] = l[prov][k].trim();
      if (typeof l[prov].apiKey === 'string' && l[prov].apiKey && !l[prov].apiKey.includes('…')) partial.llm[prov].apiKey = l[prov].apiKey.trim();
    }
    if (['', 'en', 'zh', 'ja'].includes(body.ui?.language)) partial.ui = { language: body.ui.language };
    if (typeof body.soundcloud?.clientId === 'string' && !body.soundcloud.clientId.includes('…')) partial.soundcloud.clientId = body.soundcloud.clientId.trim();
    saveConfig(partial);
    app.reconfigure();
    return { config: publicConfig(app.cfg), llm: app.llm?.describe() || null, llmError: app.llmError };
  });
  route('POST', '/api/llm/test', async () => {
    const t0 = Date.now();
    const text = await app.requireLLM().complete({ system: 'Reply with exactly: OK', prompt: 'Say OK' });
    return { ok: true, provider: app.llm.describe(), reply: text.trim().slice(0, 100), ms: Date.now() - t0 };
  });

  // ---- dispatcher ---------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!isLocalRequest(req)) httpError(403, 'Forbidden origin');
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      if (app.library.refreshIfChanged()) { offline.schedule(); broadcast('library', { at: Date.now() }); }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) httpError(404, 'Not found');
      const params = Object.fromEntries(Object.entries(url.pathname.match(r.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const raw = (req.headers['content-type'] || '').startsWith('application/octet-stream');
      const body = !raw && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const out = await r.handler({ req, res, params, query: url.searchParams, body });
      if (out === STREAMED) return;
      sendJson(res, 200, out);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      sendJson(res, e.status || 500, { error: e.message });
    }
  });
  server.broadcast = broadcast;
  return server;
}

const STREAMED = Symbol('streamed');

function httpError(status, message) { const e = new Error(message); e.status = status; throw e; }

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/** Block DNS rebinding and cross-site requests. CLI/MCP clients may omit Origin. */
function isLocalRequest(req) {
  const local = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h || '');
  if (!local(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    // The browser and Electron UI both load this HTTP server. Opaque origins
    // (including sandboxed frames and file: pages) must never control it.
    try {
      const expected = new URL(`http://${req.headers.host}`).origin;
      if (origin !== expected) return false;
    } catch { return false; }
  }
  return true;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic('/', res); // SPA fallback
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/** Start listening; resolves with the base URL. */
export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const a = server.address();
      resolve(`http://${host === '0.0.0.0' ? 'localhost' : host}:${a.port}`);
    });
  });
}

/** Is a Mixtape server already running at this address? */
export async function probe(baseUrl) {
  try {
    const r = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.app === APP_ID;
  } catch { return false; }
}
