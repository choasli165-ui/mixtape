// Stem separation engine: Demucs v4 6-stem (MIT) via ONNX Runtime for Node.
// Nothing is bundled: the runtime (~60 MB) and model (~136 MB) download once, on first use, into ~/.mixtape-agent.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '../config.js';
import { extractTgz } from './tar.js';
import { fileURLToPath } from 'node:url';

// The runtime and model can ship inside the app (engine/ next to src/), so nothing needs downloading.
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundledDir = () => process.env.MIXTAPE_ENGINE_DIR || path.join(APP_ROOT, 'engine');

export const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
export const SR = 44100;
export const SEG = 343980; // 7.8 s, fixed by the exported model
const OVERLAP = SEG >> 2, STRIDE = SEG - OVERLAP;

const ORT_VERSION = '1.20.1';
const MODEL_FILE = 'htdemucs_6s_fp16weights.onnx';
const MODEL_URL = `https://huggingface.co/adowu/htdemucs-6s-onnx/resolve/main/${MODEL_FILE}`;
const MODEL_MIN_BYTES = 100e6;

export const paths = {
  runtime: () => path.join(DATA_DIR, 'runtime'),
  model: () => path.join(DATA_DIR, 'models', MODEL_FILE),
  stems: () => path.join(DATA_DIR, 'stems'),
  audio: () => path.join(DATA_DIR, 'audio'),
  offline: () => path.join(DATA_DIR, 'offline'), // liked songs, kept until unliked
  inspirations: () => path.join(DATA_DIR, 'inspirations'), // your saved Creation Mode versions, kept until you remove them
};

let session = null, provider = null, activeDevice = null, installing = null, sessionFactory = null;

/** Tests inject a fake session factory: (onProgress) => ({ run(feeds) }). */
export function setSessionFactory(fn) { sessionFactory = fn; session = null; provider = null; activeDevice = null; gpuOffThisRun = false; adaptersCache = null; }

const hasRuntime = (dir) => ['onnxruntime-node', 'onnxruntime-common'].every((p) => fs.existsSync(path.join(dir, 'node_modules', p, 'package.json')));
const hasModel = (file) => { try { return fs.statSync(file).size > MODEL_MIN_BYTES; } catch { return false; } };
/** Bundled copy first, then the one-time download in ~/.mixtape-agent. */
function runtimeDir() { return [path.join(bundledDir(), 'runtime'), paths.runtime()].find(hasRuntime) || null; }
function modelFile() { return [path.join(bundledDir(), 'models', MODEL_FILE), paths.model()].find(hasModel) || null; }
function runtimeReady() { return !!runtimeDir(); }
function modelReady() { return !!modelFile(); }

export function status() {
  const p = prefs();
  const gpu = gpuStatus(p);
  if (sessionFactory) return { ready: true, installing: false, provider: provider || 'test', local: true, bundled: false, ...gpu };
  const rt = runtimeDir(), mf = modelFile();
  return {
    ready: !!(rt && mf), runtime: !!rt, model: !!mf, installing: !!installing, provider,
    local: true, // inference always runs on this PC via ONNX Runtime; no AI service is called
    bundled: !!(rt && mf && rt.startsWith(bundledDir()) && mf.startsWith(bundledDir())),
    downloadMB: 200, modelFile: MODEL_FILE, modelFolder: path.dirname(paths.model()), ...gpu,
  };
}

/** What the UI shows about the graphics card. */
function gpuStatus(p) {
  const adapters = gpuAdapters().map((a) => a.name);
  const supported = !!sessionFactory || process.platform === 'win32';
  const state = p.device === 'cpu' ? 'off'
    : !supported ? 'unsupported'
    : p.failures >= MAX_GPU_FAILURES ? 'disabled'
    : gpuOffThisRun ? 'failed'
    : provider === GPU_LABEL ? 'ok'
    : p.failures ? 'retry' : 'untested';
  return {
    gpu: p.device !== 'cpu', // the user's choice: graphics card (auto) or processor only
    gpuState: state, // ok | untested | retry | failed | disabled | off | unsupported
    device: provider ? (provider === GPU_LABEL ? 'gpu' : 'cpu') : null, // what the current session uses
    deviceName: provider === GPU_LABEL ? adapterName(activeDevice) : provider ? 'CPU' : null,
    gpuDeviceId: p.gpuDeviceId ?? null, adapters,
    gpuFailures: p.failures, gpuError: p.lastError || '', gpuMessage: p.lastError ? explainGpuError(p.lastError) : '',
  };
}

/** Choose where the AI runs: graphics card with automatic fallback (true) or processor only (false). */
export function setGpu(on = true) { savePrefs({ device: on ? 'auto' : 'cpu' }); dropSession(); return status(); }
/** Clear past graphics-card failures and try it again. */
export function resetGpu() { savePrefs({ device: 'auto', failures: 0, lastError: '', autoDeviceId: null }); gpuOffThisRun = false; dropSession(); return status(); }
/** Pick a graphics card (DirectML adapter index) or null for automatic. */
export function setGpuDevice(id) { savePrefs({ gpuDeviceId: id == null || id === '' ? null : Number(id), autoDeviceId: null }); dropSession(); return status(); }
function dropSession() { try { session?.release?.(); } catch {} session = null; provider = null; activeDevice = null; }

async function download(url, dest, onProgress, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, lastPct = -1;
  const tmp = dest + '.part';
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; onProgress({ label, got, total, pct }); }
  });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

/** One-time setup. Safe to call concurrently (shares one install). */
export function install(onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    if (!runtimeReady()) {
      for (const pkg of ['onnxruntime-common', 'onnxruntime-node']) {
        const file = path.join(paths.runtime(), `${pkg}-${ORT_VERSION}.tgz`);
        await download(`https://registry.npmjs.org/${pkg}/-/${pkg}-${ORT_VERSION}.tgz`, file, onProgress, `AI runtime (${pkg})`);
        const dest = path.join(paths.runtime(), 'node_modules', pkg);
        fs.rmSync(dest, { recursive: true, force: true });
        extractTgz(fs.readFileSync(file), dest);
        fs.rmSync(file, { force: true });
      }
    }
    if (!modelReady()) await download(MODEL_URL, paths.model(), onProgress, 'Song-splitting model');
    return status();
  })().finally(() => { installing = null; });
  return installing;
}

// ---------------------------------------------------------------- graphics card (DirectML)
// DirectML runs on any DirectX 12 graphics card (NVIDIA, AMD or Intel) on Windows 10/11; no CUDA or PyTorch needed.
// A graphics-card failure only switches to the processor for the current run; after MAX_GPU_FAILURES failures in a
// row the card is left off until the user presses "Try graphics card again".
const GPU_LABEL = 'GPU (DirectML)';
const MAX_GPU_FAILURES = 3;
let gpuOffThisRun = false, adaptersCache = null, adaptersPromise = null;

const prefsFile = () => path.join(DATA_DIR, 'engine.json');
function rawPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } }
function prefs() {
  const p = rawPrefs();
  if (!p.device) { // settings from older versions: { gpu:false, gpuError } meant "failed once", not "never"
    if (p.gpu === false && !p.gpuError) p.device = 'cpu';
    else { p.device = 'auto'; if (p.gpuError) { p.failures = 1; p.lastError = p.gpuError; p.lastErrorAt = p.at; } }
  }
  p.failures ||= 0;
  return p;
}
function savePrefs(patch) {
  try {
    const next = { ...prefs(), ...patch };
    delete next.gpu; delete next.gpuError; delete next.at;
    fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 1));
  } catch {}
}
const isGpuFailure = (e) => /dml|DirectML|887A00|device (instance )?has been (suspended|removed)|GPU|D3D12|DXGI/i.test(String(e?.message || e));

/** Plain-language reason for a DirectML error. */
export function explainGpuError(msg = '') {
  const m = String(msg);
  // older saved errors were cut off after "887A000"
  if (/887A0005|887A000(?![0-9A-F])|DEVICE_REMOVED|has been removed|suspended/i.test(m)) return 'Windows reset the graphics driver while the AI was running. Usually one step took longer than Windows allows (a "TDR" timeout), which is common with integrated graphics, laptops and older drivers.';
  if (/887A0006|HUNG/i.test(m)) return 'The graphics card stopped responding while the AI was running.';
  if (/887A0007|DEVICE_RESET/i.test(m)) return 'The graphics driver was reset while the AI was running.';
  if (/887A0004|UNSUPPORTED|not supported|feature level/i.test(m)) return 'This graphics card or its driver does not support DirectML (DirectX 12).';
  if (/8007000E|out of memory|OUTOFMEMORY|allocate/i.test(m)) return 'The graphics card ran out of memory.';
  if (/LoadLibrary|DirectML\.dll|could not load|error 126/i.test(m)) return 'The DirectML runtime could not be loaded.';
  return 'The graphics card could not run the AI model.';
}

/** Graphics adapters reported by Windows (names for display; the list is fetched once in the background). */
export function gpuAdapters() {
  if (adaptersCache) return adaptersCache;
  if (process.platform !== 'win32' || sessionFactory) return (adaptersCache = []);
  adaptersPromise ??= new Promise((resolve) => {
    const ps = 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
      let list = [];
      try {
        const j = JSON.parse(String(out || '').trim() || '[]');
        list = (Array.isArray(j) ? j : [j]).filter(Boolean)
          .map((a) => ({ name: String(a.Name || '').trim(), driver: String(a.DriverVersion || ''), ramMB: a.AdapterRAM ? Math.round(a.AdapterRAM / 1048576) : 0 }))
          .filter((a) => a.name && !/Basic (Render|Display)|Remote Display|Virtual|Parsec|Meta Virtual/i.test(a.name));
      } catch { /* no adapter info */ }
      adaptersCache = list; resolve(list);
    });
  });
  return [];
}
const adapterName = (id) => { const a = gpuAdapters(); return (a.length === 1 ? a[0].name : a[id ?? 0]?.name) || `Graphics card ${(id ?? 0) + 1}`; };

function recordGpuFailure(e) {
  const p = prefs();
  savePrefs({ failures: p.failures + 1, lastError: String(e?.message || e).slice(0, 400), lastErrorAt: new Date().toISOString(), autoDeviceId: null });
  gpuOffThisRun = true;
}

async function createSession(ort, kind, deviceId) {
  if (sessionFactory) return sessionFactory({ cpuOnly: kind === 'cpu', deviceId });
  const opts = kind === 'cpu'
    ? { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
    // DirectML's recommended settings: no memory pattern, sequential execution
    : { executionProviders: [{ name: 'dml', deviceId }], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential' };
  const s = await ort.InferenceSession.create(modelFile(), opts);
  s._ort = ort;
  return s;
}

async function getSession({ cpuOnly = false } = {}) {
  if (session) return session;
  let ort = null;
  if (!sessionFactory) {
    if (!status().ready) throw new Error('The song-splitting AI is not installed yet.');
    ort = createRequire(path.join(runtimeDir(), 'index.js'))('onnxruntime-node');
  }
  const p = prefs();
  const tryGpu = !cpuOnly && !gpuOffThisRun && p.device !== 'cpu' && p.failures < MAX_GPU_FAILURES && (!!sessionFactory || process.platform === 'win32');
  if (tryGpu) {
    if (!sessionFactory) { gpuAdapters(); await Promise.race([adaptersPromise, new Promise((r) => setTimeout(r, 4000))]); }
    const n = Math.max(1, Math.min(3, gpuAdapters().length));
    // Laptops often have two GPUs and DirectML's first one may be the slow integrated chip: try each once, keep the fastest.
    const ids = p.gpuDeviceId != null ? [p.gpuDeviceId] : p.autoDeviceId != null ? [p.autoDeviceId] : Array.from({ length: n }, (_, i) => i);
    let best = null, lastErr = null;
    for (const id of ids) {
      let s = null;
      try {
        s = await createSession(ort, 'gpu', id);
        const t = Date.now();
        if (!sessionFactory) await runChunk(s, new Float32Array(2 * SEG)); // warm-up: a crash happens here, not mid-song
        const ms = Date.now() - t;
        if (!best || ms < best.ms) { try { await best?.s.release?.(); } catch {} best = { s, id, ms }; } else await s.release?.();
      } catch (e) { lastErr = e; try { await s?.release?.(); } catch {} }
    }
    if (best) {
      session = best.s; provider = GPU_LABEL; activeDevice = best.id;
      if (ids.length > 1) savePrefs({ autoDeviceId: best.id });
      return session;
    }
    recordGpuFailure(lastErr || new Error('DirectML is not available'));
  }
  try {
    session = await createSession(ort, 'cpu'); provider = 'CPU'; activeDevice = null;
    return session;
  } catch (e) { throw new Error(`Could not start the AI model: ${e?.message || e}`); }
}

async function runChunk(sess, chunk) {
  if (sess._ort) {
    const out = await sess.run({ mix: new sess._ort.Tensor('float32', chunk, [1, 2, SEG]) });
    return (out.stems || Object.values(out)[0]).data;
  }
  return (await sess.run({ mix: chunk })).stems; // test double
}

function wavHeader(frames, channels = 2, sr = SR) {
  const h = Buffer.alloc(44), bytes = frames * channels * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

export const stemDir = (id) => path.join(paths.stems(), String(id).replace(/[^\w-]/g, '_'));

export function cachedStems(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(stemDir(id), 'meta.json'), 'utf8'));
    if (STEMS.every((s) => fs.existsSync(path.join(stemDir(id), `${s}.wav`)))) {
      fs.utimesSync(path.join(stemDir(id), 'meta.json'), new Date(), new Date());
      return meta;
    }
  } catch { /* not cached */ }
  return null;
}

/** Keep the most recently used `keep` songs' stems. */
function prune(keep = 12) {
  try {
    const dirs = fs.readdirSync(paths.stems()).map((d) => {
      const p = path.join(paths.stems(), d);
      let t = 0; try { t = fs.statSync(path.join(p, 'meta.json')).mtimeMs; } catch {}
      return { p, t };
    }).sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(keep)) fs.rmSync(d.p, { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

const jobs = new Map(); // id -> promise, so double clicks share one job

/**
 * Split stereo PCM (Int16 interleaved, 44.1 kHz) into 6 stem WAV files using overlap-add exactly like
 * the model's reference implementation (linear fades over a quarter segment).
 */
export function separate(id, pcm, onProgress = () => {}) {
  if (jobs.has(id)) return jobs.get(id);
  const job = (async () => {
    let sess = await getSession();
    const frames = Math.floor(pcm.length / 2);
    const dir = stemDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const fds = STEMS.map((s) => { const fd = fs.openSync(path.join(dir, `${s}.wav.part`), 'w'); fs.writeSync(fd, wavHeader(frames)); return fd; });
    try {
      const win = new Float32Array(SEG).fill(1);
      for (let i = 0; i < OVERLAP; i++) { const r = i / OVERLAP; win[i] = r; win[SEG - 1 - i] = r; }
      // rolling accumulators covering [start, start+SEG)
      const acc = STEMS.map(() => [new Float32Array(SEG), new Float32Array(SEG)]);
      const wsum = new Float32Array(SEG);
      const chunk = new Float32Array(2 * SEG);
      const nChunks = Math.max(1, Math.ceil(frames / STRIDE));
      const t0 = Date.now();
      for (let k = 0; k < nChunks; k++) {
        const start = k * STRIDE;
        const len = Math.min(SEG, frames - start);
        chunk.fill(0);
        for (let i = 0; i < len; i++) { chunk[i] = pcm[2 * (start + i)] / 32768; chunk[SEG + i] = pcm[2 * (start + i) + 1] / 32768; }
        let out;
        try { out = await runChunk(sess, chunk); } // [6][2][SEG] flattened
        catch (e) {
          if (!isGpuFailure(e) || provider === 'CPU') throw e;
          // The graphics card gave up (Windows resets the driver if one step takes too long). Finish on the processor.
          recordGpuFailure(e);
          try { await sess.release?.(); } catch {}
          session = null;
          sess = await getSession({ cpuOnly: true });
          onProgress({ pct: Math.round((k / nChunks) * 100), provider, note: 'Your graphics card stopped responding, so Mixtape switched to the processor for now. It will try the graphics card again next time.' });
          out = await runChunk(sess, chunk);
        }
        for (let s = 0; s < 6; s++) for (let c = 0; c < 2; c++) {
          const base = (s * 2 + c) * SEG, a = acc[s][c];
          for (let i = 0; i < len; i++) a[i] += out[base + i] * win[i];
        }
        for (let i = 0; i < len; i++) wsum[i] += win[i];
        // samples before the next chunk's start are final
        const last = k === nChunks - 1;
        const done = last ? len : Math.min(STRIDE, len);
        for (let s = 0; s < 6; s++) {
          const b = Buffer.alloc(done * 4);
          const [L, R] = acc[s];
          for (let i = 0; i < done; i++) {
            const w = Math.max(wsum[i], 1e-8);
            b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((L[i] / w) * 32767))), 4 * i);
            b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((R[i] / w) * 32767))), 4 * i + 2);
          }
          fs.writeSync(fds[s], b);
          if (!last) for (const a of acc[s]) { a.copyWithin(0, done); a.fill(0, SEG - done); }
        }
        if (!last) { wsum.copyWithin(0, done); wsum.fill(0, SEG - done); }
        const elapsed = (Date.now() - t0) / 1000, eta = (elapsed / (k + 1)) * (nChunks - k - 1);
        onProgress({ pct: Math.round(((k + 1) / nChunks) * 100), eta: Math.round(eta), provider, deviceName: status().deviceName });
      }
    } finally { fds.forEach((fd) => fs.closeSync(fd)); }
    for (const s of STEMS) fs.renameSync(path.join(dir, `${s}.wav.part`), path.join(dir, `${s}.wav`));
    if (provider === GPU_LABEL && prefs().failures) savePrefs({ failures: 0 }); // a whole song worked on the graphics card
    const meta = { id: String(id), frames, sr: SR, stems: STEMS, provider, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    prune();
    return meta;
  })().finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}
