import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock, CLIENT_ID } from './mock.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mixtape-test-'));
let mock, mods, server, base;

before(async () => {
  mock = await startMock();
  Object.assign(process.env, {
    MIXTAPE_HOME: HOME,
    MIXTAPE_SC_API_BASE: mock.base,
    MIXTAPE_SC_WEB_BASE: mock.base,
    MIXTAPE_LLM_PROVIDER: 'openai',
    MIXTAPE_LLM_BASE_URL: mock.base + '/v1',
    MIXTAPE_LLM_MODEL: 'mock-model',
    MIXTAPE_SEED: path.join(HOME, 'seed.json'),
  });
  fs.writeFileSync(path.join(HOME, 'seed.json'), JSON.stringify({
    title: 'My Songs',
    tracks: [
      { artist: 'zedd', title: 'alpha beta', version: 'Slowed' },
      { artist: 'yuki', title: 'gamma delta' },
      { artist: '蒋雪儿', title: '梦的翅膀' },
    ],
    recommend: { request: 'more like this', queries: ['ambient', 'drone', 'shoegaze'] },
  }));
  mods = {
    app: await import('../src/app.js'),
    server: await import('../src/server.js'),
    llm: await import('../src/llm/index.js'),
    cli: await import('../src/llm/claudeCli.js'),
  };
  const app = new mods.app.App();
  server = mods.server.createServer(app);
  base = await mods.server.listen(server, { host: '127.0.0.1', port: 0 });
});

after(async () => { server?.closeAllConnections?.(); server?.close(); await mock.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

const j = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('extractJson handles fences, chatter and nested braces', () => {
  const { extractJson } = mods.llm;
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
  assert.throws(() => extractJson('no json here'));
});

test('generates a 15-track playlist via the configured LLM', async () => {
  const events = [];
  const r = await fetch(base + '/api/playlists/generate', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ prompt: 'moody late night synths' }) });
  const text = await r.text();
  for (const chunk of text.split('\n\n').filter(Boolean)) events.push({ ev: /event: (.*)/.exec(chunk)[1], data: JSON.parse(/data: (.*)/.exec(chunk)[1]) });
  const done = events.find((e) => e.ev === 'done');
  assert.ok(done, 'done event: ' + text.slice(0, 300));
  const pl = done.data.playlist;
  assert.equal(pl.tracks.length, 15);
  assert.equal(pl.title, 'Neon Rain (Final)');
  assert.equal(new Set(pl.tracks.map((t) => t.id)).size, 15, 'unique tracks');
  const perArtist = {};
  for (const t of pl.tracks) perArtist[t.artist] = (perArtist[t.artist] || 0) + 1;
  assert.ok(Math.max(...Object.values(perArtist)) <= 2, 'max 2 per artist: ' + JSON.stringify(perArtist));
  assert.ok(!pl.tracks.some((t) => /song [34]$/.test(t.title)), 'snippets and blocked tracks filtered out');
  assert.ok(pl.tracks.every((t) => !t.transcodings), 'transient fields not persisted');
  assert.ok(events.some((e) => e.ev === 'progress' && /search plan/.test(e.data.message)));
  assert.equal(mock.calls.search, 3, 'duplicate query de-duplicated');
  assert.ok(mock.calls.prompts[0].includes('moody late night synths'));
});

test('library: list, like, unlike, Liked Songs built-in', async () => {
  const list = (await j('GET', '/api/playlists')).body;
  assert.equal(list[0].id, 'liked');
  assert.equal(list[0].count, 0);
  const pl = (await j('GET', `/api/playlists/${list.find((p) => !p.builtin).id}`)).body;
  const t = pl.tracks[2];
  assert.equal((await j('POST', `/api/likes/${t.id}`, { liked: true })).body.liked, true);
  assert.equal((await j('POST', `/api/likes/${pl.tracks[5].id}`, {})).body.liked, true, 'toggle likes');
  let liked = (await j('GET', '/api/playlists/liked')).body;
  assert.equal(liked.tracks.length, 2);
  assert.equal(liked.tracks[0].id, pl.tracks[5].id, 'newest like first');
  assert.ok(liked.tracks.every((x) => x.liked));
  const again = (await j('GET', `/api/playlists/${pl.id}`)).body;
  assert.equal(again.tracks[2].liked, true, 'liked flag shown in source playlist');
  await j('POST', `/api/likes/${t.id}`, { liked: false });
  liked = (await j('GET', '/api/playlists/liked')).body;
  assert.equal(liked.tracks.length, 1);
  assert.notEqual((await j('DELETE', '/api/playlists/liked')).status, 200, 'cannot delete Liked Songs');
});

test('liked songs are saved on this PC and play from disk; unliking removes them', async () => {
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const t = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks[7];
  await j('POST', `/api/likes/${t.id}`, { liked: true });
  let st;
  for (let i = 0; i < 50; i++) { st = (await j('GET', '/api/offline')).body; if (!st.downloading.length && !st.queued && st.saved === st.liked) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(st.saved, st.liked, JSON.stringify(st));
  const liked = (await j('GET', '/api/playlists/liked')).body;
  assert.ok(liked.tracks.every((x) => x.offline));
  assert.equal(liked.offline.saved, liked.tracks.length);
  const s = (await j('GET', `/api/stream/${t.id}`)).body;
  assert.equal(s.offline, true);
  const part = await fetch(base + s.src, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  await j('POST', `/api/likes/${t.id}`, { liked: false });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await j('GET', `/api/stream/${t.id}`)).body.offline, undefined);
  assert.equal((await fetch(base + `/api/offline/${t.id}`)).status, 404);
});

test('liking persists across restarts', async () => {
  const lib = JSON.parse(fs.readFileSync(path.join(HOME, 'library.json'), 'utf8'));
  assert.equal(lib.liked.length, 1);
  assert.equal(lib.playlists.filter((p) => !p.builtin).length, 1);
});

test('stream resolution + range-capable proxy', async () => {
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const tr = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks[0];
  const s = (await j('GET', `/api/stream/${tr.id}`)).body;
  assert.equal(s.kind, 'progressive');
  const full = await fetch(base + s.src);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 4096);
  const part = await fetch(base + s.src, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.match(part.headers.get('content-range'), /bytes 100-199\/4096/);
});

test('pre-caching the next songs makes them play from disk', async () => {
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const ids = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks.slice(10, 12).map((t) => t.id);
  assert.equal((await j('GET', `/api/stream/${ids[0]}`)).body.local, undefined);
  const r = (await j('POST', '/api/precache', { ids })).body;
  assert.deepEqual(r.started, ids);
  let s;
  for (let i = 0; i < 40; i++) { s = (await j('GET', `/api/stream/${ids[1]}`)).body; if (s.local) break; await new Promise((x) => setTimeout(x, 50)); }
  assert.equal(s.local, true);
  assert.equal(s.offline, false); // cached, not a liked download
  const full = await fetch(base + s.src);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 4096);
  assert.deepEqual((await j('POST', '/api/precache', { ids })).body.started, []); // already cached
});

test('search results can be added to a playlist or a new playlist', async () => {
  const res = (await j('GET', '/api/search?q=' + encodeURIComponent('dark techno'))).body;
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const before = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks.length;
  assert.equal((await j('POST', `/api/playlists/${pl.id}/tracks`, { track: res[0] })).body.added, true);
  assert.equal((await j('POST', `/api/playlists/${pl.id}/tracks`, { track: res[0] })).body.added, false, 'no duplicates');
  const after = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).id, res[0].id);
  assert.notEqual((await j('POST', '/api/playlists/mine/tracks', { track: res[1] })).status, 200, 'built-ins are managed automatically');
  const created = (await j('POST', '/api/playlists', { trackIds: [res[1].id], title: 'From search' })).body;
  assert.equal(created.title, 'From search');
  assert.equal(created.tracks[0].id, res[1].id);
  await j('DELETE', `/api/playlists/${pl.id}/tracks/${res[0].id}`);
  await j('DELETE', `/api/playlists/${created.id}`);
});

test('My Inspirations: saved creations are stored on this PC, play, reopen in Creation Mode and survive restarts', async () => {
  const lists = (await j('GET', '/api/playlists')).body;
  assert.ok(lists.some((p) => p.id === 'inspirations' && p.builtin), 'the built-in playlist exists before anything is saved');
  // a tiny WAV, as Studio's "Save my version" would upload it
  const wav = Buffer.alloc(44 + 8000); wav.write('RIFF', 0); wav.writeUInt32LE(36 + 8000, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
  const q = new URLSearchParams({ title: 'alpha beta – my version', kind: 'studio', sourceId: '123', sourceTitle: 'alpha beta', sourceArtist: 'zedd', durationMs: '45', ext: 'wav' });
  const r = await fetch(`${base}/api/inspirations?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: wav });
  const track = await r.json();
  assert.equal(r.status, 200, JSON.stringify(track));
  assert.match(track.id, /^insp-/); assert.equal(track.local, true); assert.equal(track.source.title, 'alpha beta');
  const pl = (await j('GET', '/api/playlists/inspirations')).body;
  assert.equal(pl.tracks[0].id, track.id);
  // plays from disk, with seeking
  const st = (await j('GET', `/api/stream/${track.id}`)).body;
  assert.equal(st.local, true);
  const part = await fetch(base + st.src, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-type'), 'audio/wav');
  // Creation Mode can open it again
  const full = await fetch(`${base}/api/create/audio/${track.id}`);
  assert.equal(full.status, 200); assert.equal((await full.arrayBuffer()).byteLength, wav.length);
  // not treated as a SoundCloud song: no pre-cache preflight failure, no offline download attempt when liked
  assert.deepEqual((await j('POST', '/api/precache', { ids: [track.id] })).body.unavailable, []);
  await j('POST', `/api/likes/${track.id}`, { liked: true });
  await j('POST', `/api/likes/${track.id}`, { liked: false });
  // still there after a restart (a fresh library reads the same file)
  const { Library } = await import('../src/library.js');
  assert.equal(new Library(path.join(HOME, 'library.json')).getPlaylist('inspirations').tracks[0].id, track.id);
  // removing it deletes the file
  await j('DELETE', `/api/playlists/inspirations/tracks/${track.id}`);
  assert.equal((await fetch(`${base}/api/stream/${track.id}`)).status >= 400 || !(await j('GET', `/api/stream/${track.id}`)).body?.local, true);
  assert.equal(fs.existsSync(path.join(HOME, 'inspirations', `${track.id}.wav`)), false);
});

test('drag-and-drop order is saved for playlists and Liked Songs', async () => {
  const res = (await j('GET', '/api/search?q=reorder')).body;
  const created = (await j('POST', '/api/playlists', { trackIds: res.slice(0, 4).map((t) => t.id), title: 'Order test' })).body;
  const ids = created.tracks.map((t) => t.id);
  const wanted = [ids[2], ids[0], ids[3], ids[1]];
  assert.deepEqual((await j('PUT', `/api/playlists/${created.id}/order`, { ids: wanted })).body.tracks.map((t) => t.id), wanted);
  const { Library } = await import('../src/library.js');
  assert.deepEqual(new Library(path.join(HOME, 'library.json')).getPlaylist(created.id).tracks.map((t) => t.id), wanted, 'persists');
  // Liked Songs: your own order, new likes on top
  for (const t of res.slice(5, 8)) await j('POST', `/api/likes/${t.id}`, { liked: true, track: t });
  const liked = (await j('GET', '/api/playlists/liked')).body.tracks.map((t) => t.id).filter((id) => res.slice(5, 8).some((t) => t.id === id));
  const mine = [liked[2], liked[0], liked[1]];
  await j('PUT', '/api/playlists/liked/order', { ids: [...mine, ...(await j('GET', '/api/playlists/liked')).body.tracks.map((t) => t.id).filter((id) => !mine.includes(id))] });
  assert.deepEqual((await j('GET', '/api/playlists/liked')).body.tracks.map((t) => t.id).filter((id) => mine.includes(id)), mine);
  await j('POST', `/api/likes/${res[9].id}`, { liked: true, track: res[9] });
  assert.equal((await j('GET', '/api/playlists/liked')).body.tracks[0].id, res[9].id, 'a new like goes on top');
  for (const t of [...res.slice(5, 8), res[9]]) await j('POST', `/api/likes/${t.id}`, { liked: false });
  await j('DELETE', `/api/playlists/${created.id}`);
});

test('artist pages load the uploader by their unique SoundCloud id', async () => {
  const t = (await j('GET', '/api/search?q=artist%20test')).body[0];
  assert.ok(t.userId, 'tracks carry the uploader id');
  const page = (await j('GET', `/api/artists/${t.userId}`)).body;
  assert.equal(page.user.id, t.userId); assert.equal(page.user.username, t.uploader);
  assert.ok(page.tracks.length >= 4 && page.tracks.every((x) => x.userId === t.userId), 'only that uploader\'s tracks');
  assert.ok(page.user.url.startsWith('https://soundcloud.com/'));
  const byTrack = (await j('GET', `/api/artists/by-track/${t.id}`)).body;
  assert.equal(byTrack.user.id, t.userId, 'older library entries without an id are resolved through the track');
  const empty = (await j('GET', '/api/artists/1009')).body; // Low Orbit: no public tracks
  assert.deepEqual(empty.tracks, []);
  assert.equal((await j('GET', '/api/artists/999')).status >= 400, true, 'unknown artist → error');
});

test('pre-cache preflight reports songs that cannot be streamed', async () => {
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const good = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks[12].id;
  const r = (await j('POST', '/api/precache', { ids: [good, '424242424'] })).body;
  assert.deepEqual(r.unavailable, ['424242424']);
  assert.ok(!r.unavailable.includes(good));
});

test('Custom API accepts full endpoint URLs', async () => {
  const { OpenAICompatProvider } = await import('../src/llm/openai.js');
  const { AnthropicProvider } = await import('../src/llm/anthropic.js');
  assert.equal(new OpenAICompatProvider({ baseUrl: 'https://x.ai/api/v1/chat/completions/', model: 'm' }).baseUrl, 'https://x.ai/api/v1');
  assert.equal(new AnthropicProvider({ baseUrl: 'https://proxy.example/v1/messages' }).baseUrl, 'https://proxy.example');
  assert.match(new OpenAICompatProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }).describe(), /^Custom API \(llama3\.1 @ localhost:11434\)$/);
  const { config } = (await j('PUT', '/api/config', { llm: { provider: 'openai', openai: { baseUrl: mock.base + '/v1/chat/completions', model: 'mock-model' } } })).body;
  assert.equal(config.llm.provider, 'openai');
  const t = await j('POST', '/api/llm/test');
  assert.equal(t.status, 200, JSON.stringify(t.body));
});

test('HLS playlists are rewritten through the proxy', async () => {
  const pl = (await j('GET', '/api/playlists')).body.find((p) => !p.builtin);
  const tr = (await j('GET', `/api/playlists/${pl.id}`)).body.tracks[0];
  // Progressive-capable tracks are served progressively, so the HLS endpoint refuses them
  assert.equal((await fetch(`${base}/api/hls/${tr.id}.m3u8`)).status, 400);
  const hlsOnly = (await j('GET', '/api/search?q=' + encodeURIComponent('hls test'))).body.find((t) => / song 5$/.test(t.title));
  const s = (await j('GET', `/api/stream/${hlsOnly.id}`)).body;
  assert.equal(s.kind, 'hls');
  const m3u8 = await (await fetch(base + s.src)).text();
  const urls = m3u8.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith('/api/proxy?u=')), m3u8);
  assert.match(m3u8, /#EXT-X-MAP:URI="\/api\/proxy\?u=/);
  assert.equal(await (await fetch(base + urls[0])).text(), 'SEG:seg0', 'relative segment resolved against playlist URL');
  assert.equal(await (await fetch(base + urls[1])).text(), 'SEG:seg1');
});

test('security: proxy host allow-list and foreign origins', async () => {
  const evil = Buffer.from('https://example.com/secret').toString('base64url');
  assert.equal((await fetch(`${base}/api/proxy?u=${evil}`)).status, 403);
  const r = await fetch(base + '/api/playlists', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const cfg = (await j('GET', '/api/config')).body;
  assert.equal(cfg.config.llm.provider, 'openai');
});

test('security: opaque and other local origins cannot send simple POST requests', async () => {
  const initial = { trackId: 'origin-check' };
  assert.equal((await j('POST', '/api/player/state', initial, { origin: base })).status, 200,
    'the browser and Electron UI may use the server origin');
  for (const origin of ['null', '', 'http://127.0.0.1:1', base.replace('http:', 'https:'), 'file://', 'invalid-origin']) {
    const response = await fetch(base + '/api/player/state', {
      method: 'POST',
      headers: { origin, 'content-type': 'text/plain' },
      body: JSON.stringify({ trackId: 'untrusted-change' }),
    });
    assert.equal(response.status, 403, `reject Origin: ${JSON.stringify(origin)}`);
  }
  const current = await j('GET', '/api/player/state');
  assert.equal(current.body.state.trackId, initial.trackId, 'rejected requests did not change player state');
  assert.equal((await j('POST', '/api/player/state', { trackId: 'cli-origin-check' })).status, 200,
    'CLI and MCP clients may omit Origin');
});

test('remote control relays commands to connected players', async () => {
  const ctrl = new AbortController();
  const es = await fetch(base + '/api/events', { signal: ctrl.signal });
  const reader = es.body.getReader();
  await reader.read(); // hello
  const r = await j('POST', '/api/player/command', { action: 'next' });
  assert.equal(r.body.delivered, 1);
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: command[\s\S]*"next"/);
  assert.equal((await j('POST', '/api/player/command', { action: 'rm -rf' })).status, 400);
  ctrl.abort();
});

test('Claude CLI provider parses `claude -p --output-format json` output', async () => {
  const fake = path.join(HOME, 'fake-claude.mjs');
  fs.writeFileSync(fake.replace('.mjs','.cjs'), `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const a=process.argv.slice(2);
    if(!a.includes('-p')||!a.includes('--strict-mcp-config')) { console.log(JSON.stringify({type:'result',is_error:true,result:'bad args '+a.join(' ')})); return; }
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'echo:'+s+'|sys:'+require('fs').readFileSync(a[a.indexOf('--system-prompt-file')+1],'utf8')}));});`);
  const p = new mods.cli.ClaudeCliProvider({ command: process.execPath, extraArgs: [] });
  p.buildArgs = ((orig) => (...a) => [fake.replace('.mjs','.cjs'), ...orig.apply(p, a)])(p.buildArgs);
  assert.equal(await p.complete({ system: 'SYS', prompt: 'hello' }), 'echo:hello|sys:SYS');
  const missing = new mods.cli.ClaudeCliProvider({ command: 'definitely-not-claude-xyz' });
  await assert.rejects(missing.complete({ prompt: 'x' }), /not found/);
});

test('matchScore: title + artist matching incl. CJK and version tags', async () => {
  const { matchScore } = await import('../src/seed.js');
  const seed = { artist: 'satirin', title: 'MATUSHKA ULTRAFUNK', version: 'Super Slowed' };
  const good = matchScore(seed, { title: 'MATUSHKA ULTRAFUNK (Super Slowed)', artist: 'satirin', uploader: 'satirin' });
  const plain = matchScore(seed, { title: 'MATUSHKA ULTRAFUNK', artist: 'satirin', uploader: '' });
  const wrong = matchScore(seed, { title: 'MONTAGEM KRISKO FUNK', artist: 'satirin', uploader: '' });
  assert.ok(good > plain && plain >= 0.94, `${good} ${plain}`);
  assert.ok(wrong < 0.7, String(wrong));
  assert.ok(matchScore({ artist: '蒋雪儿Snow.J', title: '梦的翅膀受了伤' }, { title: '梦的翅膀受了伤', artist: '蒋雪儿', uploader: '' }) >= 0.75);
});

test('built-ins: My Songs from the seed list, For You recommendations', async () => {
  const mine = (await j('POST', '/api/builtin/mine/refresh', {})).body.playlist;
  assert.equal(mine.id, 'mine');
  assert.equal(mine.tracks.length, 3);
  assert.match(mine.tracks[0].title, /alpha beta/);
  const fy = (await j('POST', '/api/builtin/for-you/refresh', {})).body.playlist;
  assert.equal(fy.id, 'for-you');
  assert.equal(fy.tracks.length, 15);
  const mineIds = new Set(mine.tracks.map((t) => t.id));
  assert.ok(fy.tracks.every((t) => !mineIds.has(t.id)), 'recommendations exclude owned tracks');
  assert.ok(mock.calls.prompts.at(-1).includes('alpha beta'), 'LLM sees the library as taste');
  const order = (await j('GET', '/api/playlists')).body.map((p) => p.id);
  assert.deepEqual(order.slice(0, 3), ['liked', 'mine', 'for-you']);
  assert.notEqual((await j('DELETE', '/api/playlists/mine')).status, 200);
  const fy2 = (await j('POST', '/api/builtin/for-you/refresh', {})).body.playlist;
  const overlap = fy2.tracks.filter((t) => fy.tracks.some((x) => x.id === t.id)).length;
  assert.ok(overlap < 15, 'refresh rotates in new tracks');
});

test('MCP server: Claude as curator (search -> create -> like -> play)', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/mixtape.js'), 'mcp'], { env: { ...process.env, MIXTAPE_PORT: String(port), PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); pending.get(m.id)?.(m); }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'mixtape');
    assert.match(init.result.instructions, /exactly 15/);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
    for (const n of ['search_soundcloud', 'create_playlist', 'generate_playlist', 'like_track', 'play', 'playback_control', 'now_playing', 'list_playlists', 'get_playlist']) assert.ok(tools.includes(n), n);

    const search = await call('search_soundcloud', { queries: ['ambient piano', 'neoclassical'] });
    assert.ok(!search.isError, search.content[0].text);
    const ids = [...search.content[0].text.matchAll(/^(\d+) \|/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 30);

    const short = await call('create_playlist', { title: 'Too short', tracks: ids.slice(0, 5).map((id) => ({ id })) });
    assert.equal(short.isError, true);

    const created = await call('create_playlist', { title: 'Quiet Keys', description: 'Soft piano.', request: 'calm piano', tracks: ids.slice(0, 15).map((id) => ({ id, why: 'gentle' })) });
    assert.ok(!created.isError, created.content[0].text);
    assert.match(created.content[0].text, /Quiet Keys .*15 tracks/);
    const plId = /playlist id: (\w+)/.exec(created.content[0].text)[1];

    const liked = await call('like_track', { track_id: ids[0] });
    assert.match(liked.content[0].text, /added to Liked Songs/);
    const likedPl = await call('get_playlist', { playlist_id: 'liked' });
    // 1 liked in an earlier test (same data dir, different process) + this one, newest first
    assert.match(likedPl.content[0].text, /Liked Songs.*2 tracks/);
    assert.match(likedPl.content[0].text, new RegExp(` 1\\. ♥ .*\\[id ${ids[0]}\\]`));

    const list = await call('list_playlists', {});
    assert.match(list.content[0].text, /Quiet Keys/);
    const play = await call('play', { playlist_id: plId });
    assert.match(play.content[0].text, /Opened the player/);
    const np = await call('now_playing', {});
    assert.match(np.content[0].text, /No player is open/);
    const unknown = await rpc('bogus/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.kill();
  }
});
