import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMock } from './mock.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mixtape-create-'));
let mock, server, base, engine;

before(async () => {
  mock = await startMock();
  Object.assign(process.env, { MIXTAPE_HOME: HOME, MIXTAPE_SC_API_BASE: mock.base, MIXTAPE_SC_WEB_BASE: mock.base, MIXTAPE_LLM_PROVIDER: 'openai', MIXTAPE_LLM_BASE_URL: mock.base + '/v1', MIXTAPE_LLM_MODEL: 'm' });
  engine = await import('../src/create/engine.js');
  // Stand-in model: stem s = mix × (s+1)/21, so the six stems sum back to the mix.
  engine.setSessionFactory(async () => ({
    async run({ mix }) {
      const n = engine.SEG, out = new Float32Array(6 * 2 * n);
      for (let s = 0; s < 6; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[(s * 2 + c) * n + i] = mix[c * n + i] * (s + 1) / 21;
      return { stems: out };
    },
  }));
  const { App } = await import('../src/app.js');
  const { createServer, listen } = await import('../src/server.js');
  server = createServer(new App());
  base = await listen(server, { host: '127.0.0.1', port: 0 });
});
after(async () => { server?.closeAllConnections?.(); server?.close(); await mock.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

function readWav(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  const frames = b.readUInt32LE(40) / 4;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { L[i] = b.readInt16LE(44 + 4 * i) / 32767; R[i] = b.readInt16LE(46 + 4 * i) / 32767; }
  return { L, R, frames };
}

async function sseCall(url, body) {
  const r = await fetch(base + url, { method: 'POST', headers: body ? { 'content-type': 'application/octet-stream' } : {}, body });
  const text = await r.text();
  const events = text.split('\n\n').filter(Boolean).map((c) => ({ ev: /event: (.*)/.exec(c)[1], data: JSON.parse(/data: (.*)/.exec(c)[1]) }));
  return events;
}

test('tar extractor unpacks npm-style tarballs safely', async () => {
  const { extractTgz } = await import('../src/create/tar.js');
  const src = path.join(HOME, 'pkgsrc'), pkg = path.join(src, 'package');
  fs.mkdirSync(path.join(pkg, 'bin', 'napi-v3', 'win32', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"x"}');
  const long = 'a'.repeat(120) + '.node';
  fs.writeFileSync(path.join(pkg, 'bin', 'napi-v3', 'win32', 'x64', long), Buffer.from([1, 2, 3]));
  const tgz = path.join(HOME, 'x.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'package']);
  const dest = path.join(HOME, 'out');
  assert.ok(extractTgz(fs.readFileSync(tgz), dest) >= 2);
  assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
  assert.deepEqual([...fs.readFileSync(path.join(dest, 'bin', 'napi-v3', 'win32', 'x64', long))], [1, 2, 3]);
});

test('separation: overlap-add across chunks reproduces the stems exactly', async () => {
  const frames = Math.round(engine.SEG * 2.6) + 123; // several chunks + a ragged end
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { pcm[2 * i] = Math.round(20000 * Math.sin(i * 0.01)); pcm[2 * i + 1] = Math.round(15000 * Math.cos(i * 0.003)); }
  const events = await sseCall('/api/create/separate/777', Buffer.from(pcm.buffer));
  const done = events.find((e) => e.ev === 'done');
  assert.ok(done, JSON.stringify(events.at(-1)));
  assert.ok(events.filter((e) => e.ev === 'progress').at(-1).data.pct === 100);
  assert.deepEqual(done.data.stems, engine.STEMS);
  let maxErr = 0;
  for (let s = 0; s < 6; s++) {
    const w = readWav(path.join(engine.stemDir('777'), `${engine.STEMS[s]}.wav`));
    assert.equal(w.frames, frames);
    for (let i = 1; i < frames; i += 97) {
      const want = (pcm[2 * i] / 32768) * (s + 1) / 21;
      maxErr = Math.max(maxErr, Math.abs(w.L[i] - want));
    }
  }
  assert.ok(maxErr < 2e-4, `max error ${maxErr}`);
  const info = await (await fetch(base + '/api/create/stems/777')).json();
  assert.equal(info.ready, true);
  const wav = await fetch(base + info.urls.vocals);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(base + '/api/create/stems/777/evil.wav')).status, 404);
  assert.equal((await (await fetch(base + '/api/create/stems/999')).json()).ready, false);
});

test('full audio: HLS segments (with init map) are joined in order and cached', async () => {
  const hls = (await (await fetch(base + '/api/search?q=' + encodeURIComponent('hls test'))).json()).find((t) => / song 5$/.test(t.title));
  const r = await fetch(`${base}/api/create/audio/${hls.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mp4');
  assert.equal(await r.text(), 'SEG:initSEG:seg0SEG:seg1');
  const searches = mock.calls.search;
  const again = await fetch(`${base}/api/create/audio/${hls.id}`);
  assert.equal(await again.text(), 'SEG:initSEG:seg0SEG:seg1');
  assert.equal(mock.calls.search, searches);
  // progressive tracks download in one piece
  const prog = (await (await fetch(base + '/api/search?q=prog')).json())[0];
  const p = await fetch(`${base}/api/create/audio/${prog.id}`);
  assert.equal(p.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await p.arrayBuffer()).byteLength, 4096);
});

test('graphics card failure mid-song falls back to the processor and finishes', async () => {
  let gpuCalls = 0, cpuCalls = 0;
  engine.setSessionFactory(async ({ cpuOnly } = {}) => ({
    async run({ mix }) {
      if (!cpuOnly) { if (++gpuCalls === 2) throw new Error('ExecutionProvider.cpp(962)\\onnxruntime.dll Exception(6) 887A0005 The GPU device instance has been suspended.'); }
      else cpuCalls++;
      const n = engine.SEG, out = new Float32Array(12 * n);
      for (let s = 0; s < 6; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[(s * 2 + c) * n + i] = mix[c * n + i] / 6;
      return { stems: out };
    },
  }));
  const frames = engine.SEG * 3;
  const pcm = new Int16Array(frames * 2).map((_, i) => (i % 200) * 100);
  const events = await sseCall('/api/create/separate/gpu1', Buffer.from(pcm.buffer));
  assert.ok(events.find((e) => e.ev === 'done'), JSON.stringify(events.at(-1)));
  assert.ok(events.some((e) => e.ev === 'progress' && /processor/.test(e.data.note || '')));
  assert.equal(gpuCalls, 2);
  assert.ok(cpuCalls >= 3, String(cpuCalls)); // retried the failed chunk + the rest on CPU
  const prefs = JSON.parse(fs.readFileSync(path.join(HOME, 'engine.json'), 'utf8'));
  assert.equal(prefs.device, 'auto', 'one failure does not switch the graphics card off for good');
  assert.equal(prefs.failures, 1);
  const st = engine.status();
  assert.equal(st.gpuState, 'failed'); assert.equal(st.device, 'cpu');
  assert.match(st.gpuMessage, /reset the graphics driver/);
});

test('graphics card: retried on the next run, switched off after 3 failures, reset brings it back', async () => {
  const fresh = () => engine.setSessionFactory(async ({ cpuOnly } = {}) => ({ async run() { if (!cpuOnly) throw new Error('887A0005 device removed'); return { stems: new Float32Array(12 * engine.SEG) }; } }));
  const pcm = new Int16Array(engine.SEG * 2);
  for (let i = 0; i < 2; i++) { fresh(); await sseCall(`/api/create/separate/gpu-retry${i}`, Buffer.from(pcm.buffer)); }
  fresh();
  assert.equal(engine.status().gpuState, 'disabled');
  let gpuTried = false;
  engine.setSessionFactory(async ({ cpuOnly } = {}) => ({ async run() { if (!cpuOnly) gpuTried = true; return { stems: new Float32Array(12 * engine.SEG) }; } }));
  await sseCall('/api/create/separate/gpu-off', Buffer.from(pcm.buffer));
  assert.equal(gpuTried, false, 'stays on the processor once disabled');
  const st = await (await fetch(base + '/api/create/engine/gpu', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ reset: true }) })).json();
  assert.equal(st.gpuFailures, 0); assert.equal(st.gpu, true);
  await sseCall('/api/create/separate/gpu-back', Buffer.from(pcm.buffer));
  assert.equal(gpuTried, true, 'tries the graphics card again after reset');
  assert.equal(engine.status().device, 'gpu');
});

test('settings from older versions: a one-off GPU failure no longer means "processor forever"', () => {
  fs.writeFileSync(path.join(HOME, 'engine.json'), JSON.stringify({ gpu: false, gpuError: 'DmlFusedNode 887A0005', at: '2026-10-16T09:45:15Z' }));
  engine.setSessionFactory(async () => ({ run: async () => ({ stems: new Float32Array(0) }) }));
  const st = engine.status();
  assert.equal(st.gpu, true); assert.equal(st.gpuFailures, 1); assert.equal(st.gpuState, 'retry');
  fs.writeFileSync(path.join(HOME, 'engine.json'), JSON.stringify({ gpu: false }));
  assert.equal(engine.status().gpu, false, 'an explicit "processor only" choice is kept');
  fs.rmSync(path.join(HOME, 'engine.json'));
});

test('a bundled runtime + model is used without any download', async () => {
  const dir = path.join(HOME, 'bundle');
  for (const pkg of ['onnxruntime-node', 'onnxruntime-common']) { fs.mkdirSync(path.join(dir, 'runtime', 'node_modules', pkg), { recursive: true }); fs.writeFileSync(path.join(dir, 'runtime', 'node_modules', pkg, 'package.json'), '{}'); }
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  const fd = fs.openSync(path.join(dir, 'models', 'htdemucs_6s_fp16weights.onnx'), 'w'); fs.ftruncateSync(fd, 136e6); fs.closeSync(fd);
  process.env.MIXTAPE_ENGINE_DIR = dir;
  engine.setSessionFactory(null);
  try {
    const st = engine.status();
    assert.equal(st.ready, true);
    assert.equal(st.bundled, true);
    assert.equal(st.local, true);
    assert.equal(engine.setGpu(false).gpu, false);
    assert.equal(engine.setGpu(true).gpu, true);
  } finally { delete process.env.MIXTAPE_ENGINE_DIR; }
});

test('engine status reports readiness', async () => {
  engine.setSessionFactory(async () => ({ run: async () => ({ stems: new Float32Array(0) }) }));
  const st = await (await fetch(base + '/api/create/engine')).json();
  assert.equal(st.ready, true);
});

test('GPU errors are explained in plain words (including old, cut-off saved errors)', async () => {
  const { explainGpuError } = await import('../src/create/engine.js');
  assert.match(explainGpuError("running DmlFusedNode_0_0 node ... Exception(2) tid(a2f8) 887A000"), /TDR/);
  assert.match(explainGpuError('DXGI_ERROR_DEVICE_HUNG 887A0006'), /stopped responding/);
  assert.match(explainGpuError('887A0004'), /DirectML/);
  assert.match(explainGpuError('something else'), /could not run/);
});
