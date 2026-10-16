// Song analysis for Creation Mode: tempo + beat grid, musical key, energy sections, waveform peaks.
import { fft, hann } from './fft.js';

/** Min/max peaks for drawing a waveform with `cols` columns. Returns Float32Array [min0,max0,min1,max1,...]. */
export function peaks(ch, cols = 1200) {
  const out = new Float32Array(cols * 2);
  const step = ch.length / cols;
  for (let c = 0; c < cols; c++) {
    let mn = 0, mx = 0;
    const s = Math.floor(c * step), e = Math.min(ch.length, Math.floor((c + 1) * step));
    for (let i = s; i < e; i += 4) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[c * 2] = mn; out[c * 2 + 1] = mx;
  }
  return out;
}

/** Spectral-flux onset envelope. hop in samples. */
export function onsetEnvelope(x, sr, hop = 512, n = 1024, maxHz = sr / 2) {
  const frames = Math.max(1, Math.floor((x.length - n) / hop));
  const env = new Float32Array(frames);
  const win = hann(n), half = n / 2;
  const kMax = Math.min(half, Math.round((maxHz / sr) * n));
  let prev = new Float32Array(half);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < n; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    const cur = new Float32Array(half);
    for (let k = 1; k < kMax; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // subtract a local mean so slow loudness changes don't count as beats
  const w = 16, out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, f - w); j < Math.min(frames, f + w); j++) { s += env[j]; c++; }
    out[f] = Math.max(0, env[f] - s / c);
  }
  return out;
}

/** Tempo (BPM) and first-beat time from a mono signal. Prefers 70–180 BPM. */
export function detectTempo(x, sr) {
  const hop = 512;
  const env = onsetEnvelope(x, sr, hop);
  const fps = sr / hop;
  const minLag = Math.floor((60 / 180) * fps), maxLag = Math.ceil((60 / 70) * fps);
  const n = env.length;
  let best = -1, bestLag = minLag;
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    s /= Math.max(1, n - lag);
    score[lag] = s;
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    // gentle preference around 120 BPM (log-gaussian), plus harmonic support from double lag
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const s = (score[lag] + 0.5 * (score[2 * lag] || 0)) * w;
    if (s > best) { best = s; bestLag = lag; }
  }
  // parabolic refinement
  const a = score[bestLag - 1] || 0, b = score[bestLag], c = score[bestLag + 1] || 0;
  const d = a - 2 * b + c;
  const lag0 = d !== 0 ? bestLag + 0.5 * (a - c) / d : bestLag;
  // fine search: jointly refine tempo (±2%) and beat phase with a comb over the whole song
  const at = (t) => { const i = Math.floor(t), f = t - i; return (env[i] || 0) * (1 - f) + (env[i + 1] || 0) * f; };
  let bestLag2 = lag0, bestOff = 0, bestSum = -1;
  for (let lg = lag0 * 0.98; lg <= lag0 * 1.02; lg += lag0 * 0.0005) {
    for (let off = 0; off < lg; off += 0.25) {
      let s = 0;
      for (let t = off; t < n; t += lg) s += at(t);
      if (s > bestSum) { bestSum = s; bestLag2 = lg; bestOff = off; }
    }
  }
  const bpm = (60 * fps) / bestLag2;
  const confidence = Math.min(1, best / (score[minLag] + 1e-9) / 4);
  // flux frames are reported at the window centre
  return { bpm: Math.round(bpm * 10) / 10, firstBeat: (bestOff * hop + 512) / sr, confidence };
}

/** Choose which beat starts a bar (4/4) by low-frequency onset strength. */
export function detectDownbeat(x, sr, bpm, firstBeat) {
  const hop = 512;
  const env = onsetEnvelope(x, sr, hop, 1024, 150);
  const fps = sr / hop, period = (60 / bpm) * fps;
  const sums = [0, 0, 0, 0];
  for (let b = 0, t = firstBeat * fps; t < env.length; b++, t += period) sums[b % 4] += env[Math.round(t)] || 0;
  const k = sums.indexOf(Math.max(...sums));
  return firstBeat + (k * 60) / bpm;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Camelot wheel numbers for major keys by tonic pitch class; minor = relative major's number with "A".
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db + 1e-12);
}

/** Musical key via chroma + Krumhansl–Schmuckler profiles. */
export function detectKey(x, sr) {
  const n = 8192, hop = 8192, half = n / 2;
  const win = hann(n);
  const chroma = new Float64Array(12);
  const re = new Float64Array(n), im = new Float64Array(n);
  const kLo = Math.ceil((55 / sr) * n), kHi = Math.floor((2000 / sr) * n);
  const pcOf = new Int8Array(half).fill(-1);
  for (let k = kLo; k < Math.min(kHi, half); k++) {
    const f = (k * sr) / n;
    pcOf[k] = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12;
  }
  for (let o = 0; o + n < x.length; o += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = kLo; k < Math.min(kHi, half); k++) if (pcOf[k] >= 0) chroma[pcOf[k]] += Math.sqrt(Math.hypot(re[k], im[k]));
  }
  let best = { r: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    const rMaj = corr(chroma, rot(MAJOR)), rMin = corr(chroma, rot(MINOR));
    if (rMaj > best.r) best = { r: rMaj, tonic: t, mode: 'major' };
    if (rMin > best.r) best = { r: rMin, tonic: t, mode: 'minor' };
  }
  return describeKey(best.tonic, best.mode, best.r);
}

export function describeKey(tonic, mode, confidence = 1) {
  const relMajor = mode === 'minor' ? (tonic + 3) % 12 : tonic;
  const camelot = `${CAMELOT_MAJOR[relMajor]}${mode === 'minor' ? 'A' : 'B'}`;
  return { tonic, mode, name: `${NOTE_NAMES[tonic]} ${mode}`, camelot, confidence: Math.round(confidence * 100) / 100 };
}

/** Semitone shift (−6..+5) that moves key b onto key a (compared via relative-major tonic). */
export function keyShift(a, b) {
  const rel = (k) => (k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic);
  let d = (rel(a) - rel(b) + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

/** How well two songs fit together, in plain words. */
export function compatibility(a, b) {
  // half/double time also mixes fine
  const tempoFit = Math.max(...[b.bpm, b.bpm * 2, b.bpm / 2].map((x) => Math.min(a.bpm, x) / Math.max(a.bpm, x)));
  const shift = Math.abs(keyShift(a.key, b.key));
  const ca = parseInt(a.key.camelot), cb = parseInt(b.key.camelot);
  const wheel = Math.min(Math.abs(ca - cb), 12 - Math.abs(ca - cb));
  const score = Math.round(100 * (0.55 * Math.max(0, 1 - (1 - tempoFit) * 4) + 0.45 * Math.max(0, 1 - wheel / 4)));
  const label = score >= 75 ? 'Great match' : score >= 50 ? 'Works with tweaks' : 'Bold combination';
  return { score, label, keyShift: keyShift(a.key, b.key), wheelDistance: wheel, tempoRatio: a.bpm / b.bpm, semitoneDistance: shift };
}

/** Split the song into labelled sections by bar energy. */
export function detectSections(x, sr, bpm, downbeat) {
  const bar = (4 * 60) / bpm;
  const dur = x.length / sr;
  const bars = [];
  for (let t = downbeat; t + bar <= dur + 0.01; t += bar) {
    const s = Math.floor(t * sr), e = Math.min(x.length, Math.floor((t + bar) * sr));
    let sum = 0;
    for (let i = s; i < e; i += 8) sum += x[i] * x[i];
    bars.push({ t, e: Math.sqrt(sum / Math.max(1, (e - s) / 8)) });
  }
  if (bars.length < 4) return [{ start: 0, end: dur, label: 'Whole song', level: 1 }];
  const sorted = bars.map((b) => b.e).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 3)], q2 = sorted[Math.floor((2 * sorted.length) / 3)];
  let lv = bars.map((b) => (b.e < q1 ? 0 : b.e < q2 ? 1 : 2));
  lv = lv.map((v, i) => [lv[i - 1] ?? v, v, lv[i + 1] ?? v].sort()[1]); // median smooth
  // group in 4-bar phrases by majority level, then merge equal neighbours
  const phrases = [];
  for (let i = 0; i < lv.length; i += 4) {
    const chunk = lv.slice(i, i + 4);
    const level = Math.round(chunk.reduce((a, b) => a + b, 0) / chunk.length);
    const start = i === 0 ? 0 : bars[i].t, end = i + 4 >= bars.length ? dur : bars[i + 4].t;
    if (phrases.length && phrases.at(-1).level === level) phrases.at(-1).end = end;
    else phrases.push({ start, end, level });
  }
  return phrases.map((p, i) => {
    const next = phrases[i + 1], prev = phrases[i - 1];
    let label = p.level === 2 ? 'Drop' : p.level === 0 ? 'Break' : 'Verse';
    if (i === 0 && p.level < 2) label = 'Intro';
    else if (i === phrases.length - 1 && p.level < 2) label = 'Outro';
    else if (p.level === 1 && next?.level === 2) label = 'Build-up';
    else if (p.level === 0 && prev?.level === 2) label = 'Break';
    return { ...p, label };
  });
}

/** Full analysis used by Studio, Mashup and DJ. */
export function analyze(mono, sr, rhythmMono = mono) {
  const t = detectTempo(rhythmMono, sr);
  const downbeat = detectDownbeat(rhythmMono, sr, t.bpm, t.firstBeat);
  return {
    bpm: t.bpm, firstBeat: t.firstBeat, downbeat, tempoConfidence: t.confidence,
    key: detectKey(mono, sr),
    sections: detectSections(mono, sr, t.bpm, downbeat),
    duration: mono.length / sr,
  };
}
