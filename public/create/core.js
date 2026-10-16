// Shared Creation Mode engine: audio context, workers, stems, effects, synced playback, export.
import { peaks } from '/dsp/analyze.js';

export const SR = 44100;
export const STEM_INFO = {
  vocals: { label: 'Vocals', icon: '🎤', color: '#ff5d7a' },
  drums: { label: 'Drums', icon: '🥁', color: '#ffb36b' },
  bass: { label: 'Bass', icon: '🔊', color: '#7b5cff' },
  guitar: { label: 'Guitar', icon: '🎸', color: '#39c6d6' },
  piano: { label: 'Piano', icon: '🎹', color: '#7fd18b' },
  other: { label: 'Other sounds', icon: '✨', color: '#e6c84f' },
};
export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

export const EFFECTS = {
  none: { label: 'None', icon: '○' },
  reverb: { label: 'Big room', icon: '🏛️' },
  echo: { label: 'Echo', icon: '🔁' },
  lofi: { label: 'Lo-fi', icon: '📼' },
  distort: { label: 'Distortion', icon: '🔥' },
  underwater: { label: 'Underwater', icon: '🌊' },
  phone: { label: 'Telephone', icon: '☎️' },
  space: { label: 'Space', icon: '🪐' },
};

// ------------------------------------------------------------------ context
let ctx = null, master = null, workletReady = null;
export function audio() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
    master = buildMaster(ctx);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return { ctx, master };
}
function buildMaster(c) {
  const input = c.createGain();
  const bass = c.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 120; bass.gain.value = 0;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.15;
  const analyser = c.createAnalyser(); analyser.fftSize = 2048;
  input.connect(bass).connect(limiter).connect(analyser).connect(c.destination);
  return { input, bass, analyser, limiter };
}
export async function ensureWorklet(c = audio().ctx) {
  if (c === ctx) { workletReady ??= c.audioWorklet.addModule('/dsp/pitch-worklet.js'); return workletReady; }
  return c.audioWorklet.addModule('/dsp/pitch-worklet.js');
}

// ------------------------------------------------------------------ workers
const workers = [], queue = [], busy = new Set();
let seq = 0;
function spawn() {
  const w = new Worker('/dsp/worker.js', { type: 'module' });
  w.jobs = new Map();
  w.onmessage = (e) => {
    const { id, result, error, progress } = e.data;
    const job = w.jobs.get(id);
    if (!job) return;
    if (progress != null) return job.onProgress?.(progress);
    w.jobs.delete(id); busy.delete(w);
    error ? job.reject(new Error(error)) : job.resolve(result);
    pump();
  };
  return w;
}
function pump() {
  while (queue.length) {
    if (workers.length < Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1))) workers.push(spawn());
    const w = workers.find((x) => !busy.has(x));
    if (!w) return;
    const job = queue.shift();
    busy.add(w);
    w.jobs.set(job.id, job);
    w.postMessage({ id: job.id, op: job.op, args: job.args }, job.transfer || []);
  }
}
/** Run `op` in a background worker. */
export function work(op, args, { onProgress, transfer } = {}) {
  return new Promise((resolve, reject) => { queue.push({ id: ++seq, op, args, transfer, onProgress, resolve, reject }); pump(); });
}

// ------------------------------------------------------------------ helpers
export async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

export async function readSse(res, onProgress = () => {}) {
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
      if (ev === 'progress') onProgress(data);
      if (ev === 'error') throw new Error(data.message);
      if (ev === 'done') result = data;
    }
  }
  if (!result) throw new Error('The operation ended unexpectedly');
  return result;
}

export const mono = (buf) => {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), m = new Float32Array(L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
};
export const channels = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
export function makeBuffer(chs, sr = SR) {
  const b = new AudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr });
  chs.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}
export function peaksOf(buf, cols = 900) { return peaks(mono(buf), cols); }

export const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Pitch/tempo change in background workers, one channel per worker (in parallel). */
export async function transformBuffer(buf, opts, onProgress) {
  const prog = new Array(buf.numberOfChannels).fill(0);
  const outs = await Promise.all(channels(buf).map((ch, i) => work('transform', { channels: [ch], sr: buf.sampleRate, ...opts }, {
    transfer: [ch.buffer], onProgress: (p) => { prog[i] = p; onProgress?.(prog.reduce((a, b) => a + b, 0) / prog.length); },
  })));
  return makeBuffer(outs.map((o) => o[0]), buf.sampleRate);
}

// ------------------------------------------------------------------ track loading (memory-cached)
const audioCache = new Map(), stemCache = new Map(), analysisCache = new Map();
function remember(map, key, val, max = 4) { map.delete(key); map.set(key, val); while (map.size > max) map.delete(map.keys().next().value); return val; }

export async function loadMix(track) {
  if (audioCache.has(track.id)) return audioCache.get(track.id);
  const res = await fetch(`/api/create/audio/${encodeURIComponent(track.id)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not download the song (${res.status})`);
  const data = await res.arrayBuffer();
  const off = new OfflineAudioContext(2, 1, SR); // decodes and resamples to 44.1 kHz
  const buf = await off.decodeAudioData(data);
  return remember(audioCache, track.id, buf, 6);
}

export const engineStatus = () => api('/api/create/engine');
export async function installEngine(onProgress) {
  return readSse(await fetch('/api/create/engine/install', { method: 'POST' }), onProgress);
}

async function decodeUrl(url) {
  const data = await (await fetch(url)).arrayBuffer();
  return new OfflineAudioContext(2, 1, SR).decodeAudioData(data);
}

/** Show which device is splitting the song ("Using: graphics card · NVIDIA …") inside a loading screen. */
export function showDevice(container, p) {
  if (!p?.provider || !container) return;
  const box = container.querySelector('.cr-loading') || container;
  let line = box.querySelector('.cr-device');
  if (!line) { line = document.createElement('p'); line.className = 'cr-device'; box.appendChild(line); }
  const gpu = /GPU/.test(p.provider);
  line.className = `cr-device ${gpu ? 'gpu' : 'cpu'}`;
  line.innerHTML = `<span>${gpu ? 'Using: graphics card' : 'Using: processor'}</span> <b data-notr></b>`;
  line.querySelector('b').textContent = gpu ? (p.deviceName || '') : '';
}

/** Split a track into its 6 parts (cached on disk by the app, and in memory here). */
export async function loadStems(track, onProgress = () => {}) {
  if (stemCache.has(track.id)) return stemCache.get(track.id);
  let info = await api(`/api/create/stems/${encodeURIComponent(track.id)}`);
  if (!info.ready) {
    onProgress({ stage: 'download', text: 'Downloading the song…' });
    const mix = await loadMix(track);
    const L = mix.getChannelData(0), R = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
    const pcm = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) {
      pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
      pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
    }
    onProgress({ stage: 'split', pct: 0, text: 'Splitting the song into parts…' });
    const res = await fetch(`/api/create/separate/${encodeURIComponent(track.id)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm.buffer });
    info = await readSse(res, (p) => onProgress({ stage: 'split', pct: p.pct, eta: p.eta, provider: p.provider, deviceName: p.deviceName, note: p.note, text: `Splitting the song into parts… ${p.pct}%` }));
  }
  onProgress({ stage: 'load', text: 'Loading the parts…' });
  const entries = await Promise.all(Object.entries(info.urls).map(async ([k, u]) => [k, await decodeUrl(u)]));
  return remember(stemCache, track.id, Object.fromEntries(entries), 3);
}

/** Tempo, key and sections. Uses the drum part for rhythm when available. */
export async function analyzeTrack(track, mixBuf, stems) {
  if (analysisCache.has(track.id)) return analysisCache.get(track.id);
  const m = mono(mixBuf);
  const rhythm = stems?.drums ? mono(stems.drums) : null;
  let harmonic = m;
  if (stems?.drums) { const d = rhythm; harmonic = m.map((v, i) => v - 0.5 * d[i]); }
  const a = await work('analyze', { mono: harmonic, rhythm: rhythm || m, sr: SR }, { transfer: [harmonic.buffer, ...(rhythm ? [rhythm.buffer] : [])] });
  return remember(analysisCache, track.id, a, 8);
}

// ------------------------------------------------------------------ effects chain per part
let irCache = null;
function impulse(c, seconds = 2.6) {
  if (irCache?.sampleRate === c.sampleRate && irCache.ctx === c) return irCache.buf;
  const len = Math.round(seconds * c.sampleRate), b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
  irCache = { ctx: c, sampleRate: c.sampleRate, buf: b };
  return b;
}
function curve(drive) {
  const n = 2048, k = drive * 50, cv = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; cv[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return cv;
}
function crush(bits) {
  const n = 4096, cv = new Float32Array(n), steps = Math.pow(2, bits);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; cv[i] = Math.round(x * steps) / steps; }
  return cv;
}

/** input → pitch → filter → shaper → [dry | reverb | echo] → volume → pan → mute → meter → out */
export function makeChain(c, out, { withPitch = true } = {}) {
  const input = c.createGain();
  const pitch = withPitch ? new AudioWorkletNode(c, 'pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }) : null;
  const filter = c.createBiquadFilter(); filter.type = 'allpass';
  const shaper = c.createWaveShaper(); shaper.oversample = '2x';
  const dry = c.createGain();
  const conv = c.createConvolver(); conv.buffer = impulse(c);
  const wet = c.createGain(); wet.gain.value = 0;
  const delay = c.createDelay(2); delay.delayTime.value = 0.3;
  const fb = c.createGain(); fb.gain.value = 0;
  const echo = c.createGain(); echo.gain.value = 0;
  const volume = c.createGain();
  const pan = c.createStereoPanner();
  const mute = c.createGain();
  const meter = c.createAnalyser(); meter.fftSize = 512;
  (pitch ? input.connect(pitch).connect(filter) : input.connect(filter));
  filter.connect(shaper);
  shaper.connect(dry).connect(volume);
  shaper.connect(conv).connect(wet).connect(volume);
  shaper.connect(delay); delay.connect(fb).connect(delay); delay.connect(echo).connect(volume);
  volume.connect(pan).connect(mute).connect(meter).connect(out);
  const chain = {
    input, pitch, filter, shaper, dry, wet, delay, fb, echo, volume, pan, mute, meter,
    setEffect(name, bpm = 120) {
      const t = c.currentTime;
      filter.type = 'allpass'; shaper.curve = null; dry.gain.setValueAtTime(1, t);
      wet.gain.setValueAtTime(0, t); fb.gain.setValueAtTime(0, t); echo.gain.setValueAtTime(0, t);
      const beat = 60 / bpm;
      switch (name) {
        case 'reverb': wet.gain.setValueAtTime(0.45, t); dry.gain.setValueAtTime(0.8, t); break;
        case 'echo': delay.delayTime.setValueAtTime(Math.min(1.9, beat * 0.75), t); fb.gain.setValueAtTime(0.42, t); echo.gain.setValueAtTime(0.5, t); break;
        case 'lofi': filter.type = 'lowpass'; filter.frequency.setValueAtTime(3200, t); filter.Q.value = 0.5; shaper.curve = crush(6); break;
        case 'distort': shaper.curve = curve(0.6); dry.gain.setValueAtTime(0.55, t); break;
        case 'underwater': filter.type = 'lowpass'; filter.frequency.setValueAtTime(420, t); filter.Q.value = 6; wet.gain.setValueAtTime(0.3, t); break;
        case 'phone': filter.type = 'bandpass'; filter.frequency.setValueAtTime(1400, t); filter.Q.value = 1.2; shaper.curve = curve(0.15); break;
        case 'space': wet.gain.setValueAtTime(0.7, t); dry.gain.setValueAtTime(0.6, t); delay.delayTime.setValueAtTime(Math.min(1.9, beat), t); fb.gain.setValueAtTime(0.35, t); echo.gain.setValueAtTime(0.35, t); break;
      }
    },
    setPitchPreview(semi) { if (pitch) pitch.parameters.get('semitones').setValueAtTime(semi, c.currentTime); },
    level() {
      const a = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(a);
      let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i];
      return Math.sqrt(s / a.length);
    },
    disconnect() { [input, pitch, filter, shaper, dry, conv, wet, delay, fb, echo, volume, pan, mute, meter].forEach((n) => n?.disconnect()); },
  };
  return chain;
}

// ------------------------------------------------------------------ synced multi-part playback
/**
 * Plays many buffers in lock-step. A "part" is { buffer, at } where `at` is the timeline second at which
 * the buffer's first sample plays (can be negative). Parts route into their lane's chain input.
 */
export class MultiPlayer {
  constructor(c) { this.c = c; this.lanes = new Map(); this.sources = new Map(); this.playing = false; this.offset = 0; this.rate = 1; this.loop = null; this.duration = 0; }
  setParts(laneId, input, parts) { this.lanes.set(laneId, { input, parts }); }
  time() {
    if (!this.playing) return this.offset;
    let t = this.offset + (this.c.currentTime - this.startedAt) * this.rate;
    if (this.loop && t >= this.loop.end) t = this.loop.start + ((t - this.loop.start) % (this.loop.end - this.loop.start));
    return t;
  }
  _startLane(id, at, when) {
    const lane = this.lanes.get(id);
    if (!lane) return;
    const list = [];
    for (const p of lane.parts) {
      if (!p.buffer) continue;
      const src = this.c.createBufferSource();
      src.buffer = p.buffer;
      src.playbackRate.value = this.rate;
      src.connect(lane.input);
      let off = at - p.at, delay = 0;
      if (off < 0) { delay = -off / this.rate; off = 0; }
      if (off >= p.buffer.duration) continue;
      if (this.loop && p.at <= this.loop.start) {
        src.loop = true; src.loopStart = this.loop.start - p.at; src.loopEnd = Math.min(p.buffer.duration, this.loop.end - p.at);
      }
      src.start(when + delay, off);
      list.push(src);
    }
    this.sources.set(id, list);
  }
  _stopLane(id) { for (const s of this.sources.get(id) || []) { try { s.stop(); } catch {} s.disconnect(); } this.sources.delete(id); }
  play(at = this.time()) {
    this.stopAll();
    if (at >= this.duration - 0.05) at = this.loop?.start ?? 0;
    const when = this.c.currentTime + 0.04;
    this.offset = at; this.startedAt = when; this.playing = true;
    for (const id of this.lanes.keys()) this._startLane(id, at, when);
  }
  stopAll() { for (const id of [...this.sources.keys()]) this._stopLane(id); }
  pause() { if (!this.playing) return; this.offset = this.time(); this.playing = false; this.stopAll(); }
  seek(t) { t = Math.max(0, Math.min(this.duration, t)); if (this.playing) this.play(t); else this.offset = t; }
  setRate(r) { const t = this.time(); this.rate = r; if (this.playing) this.play(t); }
  setLoop(loop) { const t = this.time(); this.loop = loop; if (this.playing) this.play(loop && (t < loop.start || t >= loop.end) ? loop.start : t); }
  /** Swap a lane's parts without stopping the music. */
  refreshLane(id) {
    if (!this.playing) return;
    const when = this.c.currentTime + 0.03;
    const at = this.time() + 0.03 * this.rate;
    this._stopLane(id);
    // keep the same timeline mapping
    const lane = this.lanes.get(id);
    if (!lane) return;
    const saved = { offset: this.offset, startedAt: this.startedAt };
    this._startLane(id, this.loop && at >= this.loop.end ? this.loop.start : at, when);
    Object.assign(this, saved);
  }
}

// ------------------------------------------------------------------ waveform drawing
export function drawWave(canvas, pk, { color = '#ff7a45', progress = 0, dim = false, regions = [], marks = [] } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  for (const r of regions) { g.fillStyle = r.color; g.fillRect(r.x0 * w, 0, (r.x1 - r.x0) * w, h); }
  const cols = pk.length / 2, mid = h / 2;
  let max = 1e-6; for (let i = 0; i < pk.length; i++) max = Math.max(max, Math.abs(pk[i]));
  const scale = (h / 2 - 2) / max;
  for (let x = 0; x < w; x++) {
    const c = Math.min(cols - 1, Math.floor((x / w) * cols));
    const y0 = mid - pk[c * 2 + 1] * scale, y1 = mid - pk[c * 2] * scale;
    g.fillStyle = x / w <= progress ? color : dim ? '#3a3330' : hexA(color, 0.42);
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.fillStyle = 'rgba(255,255,255,.18)';
  for (const m of marks) g.fillRect(m * w, 0, 1, h);
}
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------------ export
export function encodeWav(buf) {
  const chs = channels(buf), n = chs[0].length, nc = chs.length;
  const out = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const w = (o, s) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nc, true); out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * nc * 2, true); out.setUint16(32, nc * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { out.setInt16(o, Math.max(-1, Math.min(1, chs[c][i])) * 32767, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/**
 * Add a saved creation to the built-in "My Inspirations" playlist (stored on this PC by the local server).
 * The file download still happens as before; this keeps a copy you can play and reopen in Creation Mode.
 */
export async function saveInspiration(blob, { kind = 'studio', title, track = null, durationSec = 0 } = {}, toast) {
  try {
    const q = new URLSearchParams({ kind, title: title || 'My creation', ext: /webm/.test(blob.type) ? 'webm' : 'wav' });
    if (durationSec) q.set('durationMs', String(Math.round(durationSec * 1000)));
    if (track) {
      const src = track.source?.id ? track.source : track; // remixing a saved creation keeps the original song as its source
      q.set('sourceId', String(src.id || '')); q.set('sourceTitle', src.title || ''); q.set('sourceArtist', src.artist || '');
      if (track.artwork) q.set('artwork', track.artwork);
    }
    const res = await fetch(`/api/inspirations?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast?.('Added to My Inspirations');
    return await res.json();
  } catch (e) {
    console.warn('My Inspirations', e);
    toast?.('Saved the file, but couldn’t add it to My Inspirations', true);
    return null;
  }
}
