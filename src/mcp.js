// MCP server (stdio, JSON-RPC 2.0, newline-delimited) so Claude can drive the player.
// In this mode Claude itself is the LLM: it plans searches with `search_soundcloud`, picks 15 tracks,
// and saves them with `create_playlist`. `generate_playlist` delegates to the agent's own configured LLM instead.
import readline from 'node:readline';
import { loadConfig, PLAYLIST_SIZE } from './config.js';
import { App } from './app.js';
import { createServer, listen, probe } from './server.js';
import { openBrowser } from './util/open.js';
import { ensureDefaults } from './seed.js';

const VERSION = '1.0.0';

const INSTRUCTIONS = `Mixtape is a SoundCloud music player with a local web UI.
To make a playlist for the user, YOU act as the curator:
1. Call search_soundcloud with 6-9 varied queries (genres, subgenres, scene/mood words, similar artists) derived from what the user wants.
2. From the results pick exactly ${PLAYLIST_SIZE} tracks that fit, max 2 per artist, sequenced as a good listening arc; skip spam, "type beat" ads, sped-up re-uploads and DJ mixes unless asked. Search again if you lack good options.
3. Call create_playlist with those ${PLAYLIST_SIZE} track ids, then call play to start it in the player.
Built-in playlists: "mine" (My Songs — the user's own list, the default), "for-you" (recommendations from it; refresh_recommendations rebuilds it) and "liked" (Liked Songs). The user's taste is Brazilian phonk / funk montagem / ultrafunk and slowed or sped-up edits — check get_playlist("mine") when personalising.
Use like_track to add a track to Liked Songs. Use playback_control / now_playing for transport.
generate_playlist is an alternative that lets Mixtape's own configured LLM (Claude CLI or an API) do the curation in one call.`;

const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;
const trackLine = (t, i) => `${i != null ? `${String(i + 1).padStart(2)}. ` : ''}${t.liked ? '♥ ' : ''}${t.artist} – ${t.title} (${fmtDur(t.durationMs)}) [id ${t.id}]${t.note ? ` — ${t.note}` : ''}`;
const playlistText = (p) => `${p.title}  (playlist id: ${p.id}, ${p.tracks.length} tracks)\n${p.description ? p.description + '\n' : ''}\n${p.tracks.map(trackLine).join('\n')}`;

const TOOLS = [
  {
    name: 'search_soundcloud',
    description: 'Search SoundCloud for playable full-length tracks. Pass several varied queries at once; results are merged, de-duplicated and ranked. Returns track ids to use with create_playlist.',
    inputSchema: { type: 'object', properties: {
      queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: 'Search queries, 1-5 words each (genre, mood + genre, artist names…)' },
      limit: { type: 'integer', minimum: 10, maximum: 120, default: 60, description: 'Max candidates to return' },
    }, required: ['queries'] },
    run: async (api, a) => {
      const tracks = await api('POST', '/api/search/multi', { queries: a.queries, limit: a.limit || 60 });
      if (!tracks.length) return 'No playable tracks found. Try other queries.';
      return `${tracks.length} candidates (id | artist – title | genre/tags | length | plays):\n` + tracks.map((t) =>
        `${t.id} | ${t.artist} – ${t.title} | ${[t.genre, ...(t.tags || []).slice(0, 3)].filter(Boolean).join(', ') || '-'} | ${fmtDur(t.durationMs)} | ${t.plays} plays`).join('\n');
    },
  },
  {
    name: 'create_playlist',
    description: `Save a curated playlist of exactly ${PLAYLIST_SIZE} SoundCloud tracks (ids from search_soundcloud), in play order.`,
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: 'Short evocative title' },
      description: { type: 'string', description: 'One sentence on the vibe' },
      request: { type: 'string', description: "The user's original request" },
      tracks: { type: 'array', minItems: PLAYLIST_SIZE, maxItems: PLAYLIST_SIZE, items: { type: 'object', properties: {
        id: { type: 'string' }, why: { type: 'string', description: 'Optional short note on why it fits' } }, required: ['id'] } },
    }, required: ['title', 'tracks'] },
    run: async (api, a) => {
      const tracks = (a.tracks || []).map((t) => (typeof t === 'object' ? t : { id: String(t) }));
      const ids = [...new Set(tracks.map((t) => String(t.id)))];
      if (ids.length !== PLAYLIST_SIZE) throw new Error(`Provide exactly ${PLAYLIST_SIZE} distinct track ids (got ${ids.length}).`);
      const notes = Object.fromEntries(tracks.filter((t) => t.why).map((t) => [String(t.id), t.why]));
      const p = await api('POST', '/api/playlists', { trackIds: ids, title: a.title, description: a.description || '', prompt: a.request || '', notes });
      const warn = p.tracks.length < PLAYLIST_SIZE ? `\nNote: only ${p.tracks.length} of the ids resolved; search again and add more if needed.` : '';
      return `Saved.\n${playlistText(p)}${warn}`;
    },
  },
  {
    name: 'generate_playlist',
    description: `Let Mixtape's own configured LLM (Claude CLI by default, or a configured API) plan the searches and curate a ${PLAYLIST_SIZE}-track playlist in one step. Slower; prefer search_soundcloud + create_playlist when you can curate yourself.`,
    inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'Genres, styles, moods or a free description' } }, required: ['request'] },
    run: async (api, a) => {
      const r = await api('POST', '/api/playlists/generate', { prompt: a.request });
      return playlistText(r.playlist) + (r.warnings?.length ? `\n\nWarnings: ${r.warnings.join(' ')}` : '');
    },
  },
  {
    name: 'refresh_recommendations',
    description: 'Rebuild the built-in "For You" playlist (15 tracks related to the user\'s song list and likes). Returns the new tracks.',
    inputSchema: { type: 'object', properties: {} },
    run: async (api) => playlistText((await api('POST', '/api/builtin/for-you/refresh', {})).playlist),
  },
  {
    name: 'list_playlists',
    description: 'List saved playlists, including the built-in Liked Songs (id "liked").',
    inputSchema: { type: 'object', properties: {} },
    run: async (api) => (await api('GET', '/api/playlists')).map((p) => `${p.id} — ${p.title} (${p.count} tracks)${p.prompt ? ` — “${p.prompt}”` : ''}`).join('\n'),
  },
  {
    name: 'get_playlist',
    description: 'Show the tracks of a playlist. Use id "liked" for Liked Songs.',
    inputSchema: { type: 'object', properties: { playlist_id: { type: 'string' } }, required: ['playlist_id'] },
    run: async (api, a) => playlistText(await api('GET', `/api/playlists/${encodeURIComponent(a.playlist_id)}`)),
  },
  {
    name: 'like_track',
    description: 'Mark a track as a favorite (adds it to Liked Songs) or remove it with liked=false.',
    inputSchema: { type: 'object', properties: { track_id: { type: 'string' }, liked: { type: 'boolean', default: true } }, required: ['track_id'] },
    run: async (api, a) => {
      const r = await api('POST', `/api/likes/${encodeURIComponent(a.track_id)}`, { liked: a.liked !== false });
      return r.liked ? `Track ${r.trackId} added to Liked Songs.` : `Track ${r.trackId} removed from Liked Songs.`;
    },
  },
  {
    name: 'delete_playlist',
    description: 'Delete a generated playlist (Liked Songs cannot be deleted).',
    inputSchema: { type: 'object', properties: { playlist_id: { type: 'string' } }, required: ['playlist_id'] },
    run: async (api, a) => { await api('DELETE', `/api/playlists/${encodeURIComponent(a.playlist_id)}`); return 'Deleted.'; },
  },
  {
    name: 'play',
    description: 'Start playing a playlist in the Mixtape player (opens it in the browser if needed).',
    inputSchema: { type: 'object', properties: {
      playlist_id: { type: 'string', description: 'Playlist id, or "liked"' },
      track_index: { type: 'integer', minimum: 1, description: '1-based position to start from' },
      track_id: { type: 'string', description: 'Start from this track instead' },
      shuffle: { type: 'boolean' },
    }, required: ['playlist_id'] },
    run: async (api, a, ctx) => {
      const p = await api('GET', `/api/playlists/${encodeURIComponent(a.playlist_id)}`);
      let index = a.track_index ? a.track_index - 1 : 0;
      if (a.track_id) index = Math.max(0, p.tracks.findIndex((t) => t.id === String(a.track_id)));
      const cmd = { action: 'play', playlistId: p.id, index, shuffle: !!a.shuffle };
      const r = await api('POST', '/api/player/command', cmd);
      if (!r.delivered) {
        openBrowser(`${ctx.base}/?play=${encodeURIComponent(p.id)}&index=${index}${a.shuffle ? '&shuffle=1' : ''}`);
        return `Opened the player at ${ctx.base} and queued “${p.title}”. If the browser blocks autoplay, click play once.`;
      }
      return `Playing “${p.title}” from track ${index + 1}: ${p.tracks[index] ? `${p.tracks[index].artist} – ${p.tracks[index].title}` : ''}`;
    },
  },
  {
    name: 'playback_control',
    description: 'Control playback in the open player: pause, resume, toggle, next, previous, shuffle (value true/false), repeat (value off|all|one), volume (value 0-100), seek (value seconds).',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['pause', 'resume', 'toggle', 'next', 'previous', 'shuffle', 'repeat', 'volume', 'seek'] },
      value: { description: 'Argument for shuffle/repeat/volume/seek' },
    }, required: ['action'] },
    run: async (api, a) => {
      const r = await api('POST', '/api/player/command', { action: a.action, value: a.value });
      if (!r.delivered) return 'No player is open. Use play or open_player first.';
      await new Promise((res) => setTimeout(res, 700));
      const s = await api('GET', '/api/player/state');
      return `Done (${a.action}). ${describeState(s.state)}`;
    },
  },
  {
    name: 'now_playing',
    description: 'What is playing right now, with its track id (useful before like_track).',
    inputSchema: { type: 'object', properties: {} },
    run: async (api) => {
      const s = await api('GET', '/api/player/state');
      return s.connected ? describeState(s.state) : 'No player is open.';
    },
  },
  {
    name: 'open_player',
    description: 'Open the Mixtape web player in the default browser and return its URL.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_api, _a, ctx) => { openBrowser(ctx.base); return `Player: ${ctx.base}`; },
  },
];

function describeState(s) {
  if (!s || !s.track) return 'Nothing is playing.';
  const t = s.track;
  return `${s.playing ? 'Playing' : 'Paused'}: ${t.artist} – ${t.title} [id ${t.id}]${t.liked ? ' ♥' : ''} — ${fmtDur((s.position || 0) * 1000)} / ${fmtDur(t.durationMs)}; playlist “${s.playlistTitle || ''}” (${s.playlistId}), track ${(s.index ?? 0) + 1}; shuffle ${s.shuffle ? 'on' : 'off'}, repeat ${s.repeat}, volume ${Math.round((s.volume ?? 1) * 100)}`;
}

/** Ensure a Mixtape HTTP server exists (reuse a running one, or host it in this process). */
async function ensureBackend() {
  const cfg = loadConfig();
  const existing = `http://${cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host}:${cfg.server.port}`;
  if (await probe(existing)) return { base: existing, owned: false };
  // Inside the installed desktop app (Mixtape.exe in Node mode): start the real app window and use its server,
  // which reaches SoundCloud through the system proxy.
  if (process.env.ELECTRON_RUN_AS_NODE && /mixtape\.exe$/i.test(process.execPath)) {
    const { spawn } = await import('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(process.execPath, [], { env, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probe(existing)) return { base: existing, owned: false };
    }
  }
  const app = new App();
  const server = createServer(app);
  let base;
  try { base = await listen(server, cfg.server); }
  catch { base = await listen(server, { host: cfg.server.host, port: 0 }); } // port taken by something else
  ensureDefaults(app, (m) => process.stderr.write(`[mixtape] ${m}\n`));
  return { base, owned: true, server };
}

export async function runMcp() {
  // stdout is the protocol channel: route all logging to stderr.
  console.log = console.info = console.warn = (...a) => process.stderr.write(a.join(' ') + '\n');
  let backend = null;
  const ctx = {};
  const getApi = async () => {
    backend ??= await ensureBackend();
    ctx.base = backend.base;
    return async (method, p, body) => {
      const res = await fetch(backend.base + p, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };
  };
  getApi().then(() => process.stderr.write(`[mixtape] player at ${backend.base}\n`)).catch((e) => process.stderr.write(`[mixtape] backend error: ${e.message}\n`));

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg) => {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mixtape', title: 'Mixtape music player', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping': return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const api = await getApi();
          const text = await tool.run(api, params.arguments || {}, ctx);
          return reply(id, { content: [{ type: 'text', text: String(text) }] });
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((e) => m.id != null && fail(m.id, -32603, e.message));
  });
  rl.on('close', () => process.exit(0));
}

export { TOOLS };
