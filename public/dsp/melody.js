// Turn a separated part (bass line, lead, cowbell…) into notes with YIN pitch tracking.
import { fft } from './fft.js';

/** Halve the sample rate with a small low-pass FIR. */
function decimate2(x) {
  const h = [0.0625, 0.25, 0.375, 0.25, 0.0625];
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < 5; k++) { const j = 2 * i + k - 2; if (j >= 0 && j < x.length) s += x[j] * h[k]; }
    out[i] = s;
  }
  return out;
}

/**
 * Pitch track with YIN (FFT autocorrelation). Returns per-frame { time, midi (NaN if unvoiced), rms }.
 * range: { minHz, maxHz }
 */
export function trackPitch(input, sr, { minHz = 70, maxHz = 1500, threshold = 0.15, hopSec = 0.0116 } = {}) {
  let x = input, rate = sr;
  if (sr >= 32000 && maxHz < 4000) { x = decimate2(input); rate = sr / 2; }
  const maxLag = Math.ceil(rate / minHz), minLag = Math.floor(rate / maxHz);
  const W = 1 << Math.ceil(Math.log2(maxLag * 2));
  const hop = Math.round(rate * hopSec);
  const fftN = W * 2;
  const re = new Float64Array(fftN), im = new Float64Array(fftN);
  const re2 = new Float64Array(fftN), im2 = new Float64Array(fftN);
  const frames = [];
  const d = new Float64Array(maxLag + 2);
  let peakRms = 1e-9;
  for (let o = 0; o + W + maxLag < x.length; o += hop) {
    // r(τ) = Σ_{i<W} x[i]·x[i+τ]: cross-correlate the window with the window+lags, via FFT
    let e0 = 0;
    for (let i = 0; i < W; i++) e0 += x[o + i] * x[o + i];
    const rms = Math.sqrt(e0 / W);
    peakRms = Math.max(peakRms, rms);
    if (rms < 0.002) { frames.push({ time: (o + W / 2) / rate, midi: NaN, rms }); continue; } // silence: skip the maths
    for (let i = 0; i < fftN; i++) {
      re[i] = i < W ? x[o + i] : 0; im[i] = 0;
      re2[i] = i < W + maxLag ? x[o + i] : 0; im2[i] = 0;
    }
    fft(re, im); fft(re2, im2);
    for (let i = 0; i < fftN; i++) { // conj(A)·B
      const r = re[i] * re2[i] + im[i] * im2[i], m = re[i] * im2[i] - im[i] * re2[i];
      re[i] = r; im[i] = m;
    }
    fft(re, im, true);
    // difference function d(τ) = e0 + eτ − 2 r(τ), with running energy of the shifted window
    let et = e0;
    d[0] = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      et += x[o + W + tau - 1] ** 2 - x[o + tau - 1] ** 2;
      d[tau] = e0 + et - 2 * re[tau];
    }
    // cumulative mean normalised difference
    let run = 0, tauBest = -1;
    for (let tau = 1; tau <= maxLag; tau++) {
      run += d[tau];
      const cmnd = run > 0 ? (d[tau] * tau) / run : 1;
      d[tau] = cmnd;
    }
    for (let tau = Math.max(2, minLag); tau < maxLag; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
        tauBest = tau;
        break;
      }
    }
    let midi = NaN;
    if (tauBest > 0) {
      const a = d[tauBest - 1], b = d[tauBest], c = d[tauBest + 1];
      const den = a - 2 * b + c;
      const t = den !== 0 ? tauBest + (0.5 * (a - c)) / den : tauBest;
      const f = rate / t;
      midi = 69 + 12 * Math.log2(f / 440);
    }
    frames.push({ time: (o + W / 2) / rate, midi, rms });
  }
  const gate = peakRms * 0.06; // ≈ −24 dB below the loudest frame
  for (const f of frames) if (f.rms < gate) f.midi = NaN;
  return { frames, hop: hop / rate };
}

/** Group pitch frames into notes: [{ start, dur, midi, vel }]. */
export function framesToNotes({ frames, hop }, { minDur = 0.06, bpm = 0, quantize = false, offset = 0 } = {}) {
  const notes = [];
  let cur = null;
  const close = () => {
    if (cur && cur.end - cur.start >= minDur) {
      const ms = cur.midis.sort((a, b) => a - b);
      notes.push({ start: cur.start, dur: cur.end - cur.start, midi: Math.round(ms[Math.floor(ms.length / 2)]), vel: Math.min(1, cur.peak) });
    }
    cur = null;
  };
  const peak = Math.max(1e-9, ...frames.map((f) => f.rms));
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (Number.isNaN(f.midi)) { close(); continue; }
    const m = f.midi;
    const prevRms = frames[i - 1]?.rms ?? 0;
    const onset = f.rms > prevRms * 2 && f.rms > peak * 0.15; // sudden loudness jump = new note
    if (cur && Math.abs(m - cur.ref) < 0.7 && !onset) {
      cur.end = f.time + hop; cur.midis.push(m); cur.peak = Math.max(cur.peak, f.rms / peak);
    } else {
      close();
      cur = { start: f.time, end: f.time + hop, ref: Math.round(m), midis: [m], peak: f.rms / peak };
    }
  }
  close();
  if (quantize && bpm > 0) {
    const grid = 60 / bpm / 4; // 16th notes
    for (const n of notes) {
      const s = offset + Math.round((n.start - offset) / grid) * grid;
      const e = offset + Math.max(1, Math.round((n.start + n.dur - offset) / grid)) * grid;
      n.start = Math.max(0, s); n.dur = Math.max(grid * 0.5, e - s);
    }
  }
  return notes;
}

export function extractNotes(mono, sr, { lane = 'other', bpm = 0, quantize = false, offset = 0 } = {}) {
  const range = lane === 'bass' ? { minHz: 30, maxHz: 400, hopSec: 0.02 } : lane === 'vocals' ? { minHz: 80, maxHz: 1100 } : { minHz: 60, maxHz: 2000 };
  return framesToNotes(trackPitch(mono, sr, range), { bpm, quantize, offset });
}
