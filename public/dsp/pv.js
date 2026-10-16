// Phase-vocoder time-stretch (with identity phase locking) + resampling = pitch shift without tempo change.
import { fft, hann } from './fft.js';

const N = 2048, HS = 512; // frame size, synthesis hop
const TWO_PI = 2 * Math.PI;
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);

/** Time-stretch one channel: output length ≈ input length × alpha. */
export function stretch(input, alpha, onProgress) {
  if (Math.abs(alpha - 1) < 1e-4) return Float32Array.from(input);
  const ha = HS / alpha; // analysis hop (fractional)
  const win = hann(N);
  const outLen = Math.ceil(input.length * alpha) + N;
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const half = N / 2 + 1;
  const prevPhase = new Float64Array(half), synthPhase = new Float64Array(half);
  const mag = new Float64Array(half), phase = new Float64Array(half);
  const re = new Float64Array(N), im = new Float64Array(N);
  const frames = Math.max(1, Math.ceil(input.length / ha) + 1);
  const isPeak = new Uint8Array(half), peakOf = new Int32Array(half), leftP = new Int32Array(half);
  let first = true;

  for (let m = 0; m < frames; m++) {
    const pos = m * ha - N / 2; // centre frames on the signal
    const ip = Math.floor(pos), frac = pos - ip;
    for (let i = 0; i < N; i++) {
      const j = ip + i;
      const a = j >= 0 && j < input.length ? input[j] : 0;
      const b = j + 1 >= 0 && j + 1 < input.length ? input[j + 1] : 0;
      re[i] = (a + (b - a) * frac) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) { mag[k] = Math.hypot(re[k], im[k]); phase[k] = Math.atan2(im[k], re[k]); }

    if (first) { for (let k = 0; k < half; k++) synthPhase[k] = phase[k]; first = false; }
    else {
      // peaks: local maxima over ±2 bins
      for (let k = 0; k < half; k++) isPeak[k] = (k > 1 && k < half - 2 && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) ? 1 : 0;
      let last = -1;
      for (let k = 0; k < half; k++) if (isPeak[k]) {
        const omega = (TWO_PI * k) / N;
        const dphi = wrap(phase[k] - prevPhase[k] - omega * ha);
        synthPhase[k] += (omega + dphi / ha) * HS;
        last = k;
      }
      if (last < 0) { // no peaks (silence/noise): plain vocoder
        for (let k = 0; k < half; k++) {
          const omega = (TWO_PI * k) / N;
          synthPhase[k] += (omega + wrap(phase[k] - prevPhase[k] - omega * ha) / ha) * HS;
        }
      } else {
        // identity phase locking: each bin follows its nearest peak
        let lp = -1;
        for (let k = 0; k < half; k++) { if (isPeak[k]) lp = k; leftP[k] = lp; }
        let rp = -1;
        for (let k = half - 1; k >= 0; k--) { if (isPeak[k]) rp = k; const l = leftP[k]; peakOf[k] = l < 0 ? rp : rp < 0 ? l : (k - l <= rp - k ? l : rp); }
        for (let k = 0; k < half; k++) if (!isPeak[k] && peakOf[k] >= 0) synthPhase[k] = synthPhase[peakOf[k]] + (phase[k] - phase[peakOf[k]]);
      }
    }
    for (let k = 0; k < half; k++) prevPhase[k] = phase[k];

    for (let k = 0; k < half; k++) { re[k] = mag[k] * Math.cos(synthPhase[k]); im[k] = mag[k] * Math.sin(synthPhase[k]); }
    for (let k = half; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
    fft(re, im, true);
    const o = m * HS;
    for (let i = 0; i < N; i++) {
      const idx = o + i;
      if (idx >= outLen) break;
      out[idx] += re[i] * win[i];
      norm[idx] += win[i] * win[i];
    }
    if (onProgress && (m & 255) === 0) onProgress(m / frames);
  }
  // remove the N/2 centring offset and normalise by the window overlap
  const target = Math.round(input.length * alpha);
  const res = new Float32Array(target);
  for (let i = 0; i < target; i++) { const j = i + N / 2; const w = norm[j]; res[i] = w > 1e-6 ? out[j] / w : 0; }
  return res;
}

/** Cubic (Hermite) resampling: read input at position i*step. */
export function resample(input, outLen, step) {
  const out = new Float32Array(outLen);
  const n = input.length;
  const at = (i) => (i < 0 ? input[0] : i >= n ? input[n - 1] : input[i]);
  for (let i = 0; i < outLen; i++) {
    const x = i * step, i0 = Math.floor(x), t = x - i0;
    const y0 = at(i0 - 1), y1 = at(i0), y2 = at(i0 + 1), y3 = at(i0 + 2);
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    out[i] = ((c3 * t + c2) * t + c1) * t + y1;
  }
  return out;
}

/**
 * Change tempo by `tempoRatio` (2 = twice as fast) and pitch by `semitones`, independently.
 * Output length = input length / tempoRatio.
 */
export function stretchPitch(input, { tempoRatio = 1, semitones = 0 } = {}, onProgress) {
  const r = Math.pow(2, semitones / 12);
  const outLen = Math.round(input.length / tempoRatio);
  if (Math.abs(r - 1) < 1e-4 && Math.abs(tempoRatio - 1) < 1e-4) return Float32Array.from(input);
  const alpha = r / tempoRatio; // stretch, then resample by r
  const st = stretch(input, alpha, onProgress);
  return Math.abs(r - 1) < 1e-4 ? fit(st, outLen) : resample(st, outLen, r);
}

export const pitchShift = (input, semitones, onProgress) => stretchPitch(input, { semitones }, onProgress);

function fit(a, len) { if (a.length === len) return a; const o = new Float32Array(len); o.set(a.subarray(0, len)); return o; }

/** Apply a function to [start,end) of a channel and splice the result back with short crossfades. */
export function processRegion(ch, sr, start, end, fn) {
  const fade = Math.round(0.03 * sr);
  const s = Math.max(0, Math.round(start * sr) - fade), e = Math.min(ch.length, Math.round(end * sr) + fade);
  const seg = fn(ch.subarray(s, e));
  const out = Float32Array.from(ch);
  for (let i = 0; i < e - s; i++) {
    const g = i < fade ? i / fade : i > e - s - fade ? (e - s - i) / fade : 1;
    out[s + i] = ch[s + i] * (1 - g) + (seg[i] ?? 0) * g;
  }
  return out;
}
