// Built-in instruments for "Swap instrument". Each renders a list of notes into a buffer — no samples to download.
const TAU = 2 * Math.PI;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** Single-cycle wavetable from harmonic amplitudes (band-limited for the given pitch). */
const tableCache = new Map();
function table(key, f, sr, amps) {
  const k = `${key}:${Math.round(f)}`;
  let t = tableCache.get(k);
  if (t) return t;
  const L = 2048;
  t = new Float32Array(L + 1);
  const nMax = Math.max(1, Math.floor((sr * 0.45) / f));
  for (let h = 1; h <= Math.min(nMax, amps.length); h++) {
    const a = amps[h - 1];
    if (!a) continue;
    for (let i = 0; i < L; i++) t[i] += a * Math.sin((TAU * h * i) / L);
  }
  let mx = 1e-9; for (let i = 0; i < L; i++) mx = Math.max(mx, Math.abs(t[i]));
  for (let i = 0; i < L; i++) t[i] /= mx;
  t[L] = t[0];
  if (tableCache.size > 4000) tableCache.clear();
  tableCache.set(k, t);
  return t;
}
const series = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1));

/** ADSR in seconds. */
function env(t, dur, { a = 0.005, d = 0.2, s = 0.6, r = 0.15 }) {
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  const rt = t - dur;
  return rt < r ? s * (1 - rt / r) : 0;
}

/** Wavetable oscillator note with optional vibrato and a bright→dark crossfade over time. */
function wtNote(out, sr, start, n, f, vel, { bright, dark = bright, key, adsr, decay = 0, vibrato = 0, detune = 0, gain = 0.5 }) {
  const tb = table(key + 'b', f, sr, bright), td = table(key + 'd', f, sr, dark);
  const len = Math.ceil((n.dur + (adsr.r || 0.15)) * sr);
  const voices = detune ? [-detune, detune] : [0];
  for (const dv of voices) {
    let ph = Math.random() * 2048;
    const inc0 = (f * Math.pow(2, dv / 1200) * 2048) / sr;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= out.length) break;
      const t = i / sr;
      const inc = vibrato ? inc0 * (1 + vibrato * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.3)) : inc0;
      ph += inc; if (ph >= 2048) ph -= 2048;
      const i0 = ph | 0, fr = ph - i0;
      const vb = tb[i0] + (tb[i0 + 1] - tb[i0]) * fr, vd = td[i0] + (td[i0 + 1] - td[i0]) * fr;
      const mix = decay ? Math.exp(-t * decay) : 1;
      const e = env(t, n.dur, adsr);
      out[idx] += (vb * mix + vd * (1 - mix)) * e * vel * gain / voices.length;
    }
  }
}

function pluck(out, sr, start, n, f, vel, bright = 0.5) {
  // Karplus–Strong string
  const p = Math.max(2, Math.round(sr / f - 0.5)); // averaging filter adds half a sample of delay
  const buf = new Float32Array(p);
  for (let i = 0; i < p; i++) buf[i] = Math.random() * 2 - 1;
  const len = Math.ceil(Math.min(n.dur + 0.4, 4) * sr);
  const damp = 0.996 - (f / 20000) * 0.02;
  let j = 0;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.length) break;
    const nj = (j + 1) % p;
    const v = buf[j];
    buf[j] = damp * (bright * v + (1 - bright) * 0.5 * (v + buf[nj]));
    const rel = i / sr > n.dur ? Math.max(0, 1 - (i / sr - n.dur) / 0.08) : 1;
    out[idx] += v * vel * 0.45 * rel;
    j = nj;
  }
}

function bass808(out, sr, start, n, f, vel) {
  const len = Math.ceil((n.dur + 0.25) * sr);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.length) break;
    const t = i / sr;
    const freq = f * (1 + 1.2 * Math.exp(-t / 0.018)); // pitch drop "punch"
    ph += (TAU * freq) / sr;
    const e = Math.min(1, t / 0.002) * Math.exp(-t / Math.max(0.35, n.dur * 0.9)) * (t > n.dur ? Math.max(0, 1 - (t - n.dur) / 0.2) : 1);
    out[idx] += Math.tanh(2.2 * Math.sin(ph)) * 0.55 * e * vel;
  }
}

function cowbell(out, sr, start, n, f, vel) {
  // two detuned square-ish partials, band-limited, quick decay: the phonk lead sound
  const len = Math.ceil(Math.min(n.dur + 0.3, 1.5) * sr);
  const ratios = [1, 1.48];
  const tbs = ratios.map((r) => table('cow' + r, f * r, sr, series(15, (h) => (h % 2 ? 1 / h : 0))));
  const phs = [0, 0];
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.length) break;
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < 2; k++) {
      phs[k] += (f * ratios[k] * 2048) / sr; if (phs[k] >= 2048) phs[k] -= 2048;
      v += tbs[k][phs[k] | 0];
    }
    const e = Math.min(1, t / 0.002) * (0.6 * Math.exp(-t / 0.05) + 0.4 * Math.exp(-t / 0.35));
    out[idx] += v * 0.28 * e * vel;
  }
}

function bell(out, sr, start, n, f, vel, partials = [[1, 1, 1.6], [2.76, 0.5, 0.9], [5.4, 0.25, 0.5], [8.93, 0.12, 0.3]]) {
  const len = Math.ceil(Math.min(n.dur + 1.2, 3) * sr);
  for (const [r, a, d] of partials) {
    const fr = f * r;
    if (fr > sr * 0.45) continue;
    const w = (TAU * fr) / sr;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= out.length) break;
      const t = i / sr;
      out[idx] += Math.sin(w * i) * a * Math.exp(-t / d) * Math.min(1, t / 0.002) * vel * 0.4;
    }
  }
}

export const INSTRUMENTS = {
  piano: { label: 'Piano', icon: '🎹', render: (o, sr, s, n, f, v) => wtNote(o, sr, s, n, f, v, { key: 'pno', bright: series(12, (h) => 1 / Math.pow(h, 1.3)), dark: series(4, (h) => 1 / (h * h)), decay: 2.5, adsr: { a: 0.003, d: 1.2, s: 0.25, r: 0.25 }, gain: 0.5 }) },
  guitar: { label: 'Guitar', icon: '🎸', render: (o, sr, s, n, f, v) => pluck(o, sr, s, n, f, v, 0.55) },
  strings: { label: 'Strings', icon: '🎻', render: (o, sr, s, n, f, v) => wtNote(o, sr, s, n, f, v, { key: 'str', bright: series(24, (h) => 1 / h), dark: series(10, (h) => 1 / (h * 1.4)), decay: 0.8, vibrato: 0.004, detune: 7, adsr: { a: 0.14, d: 0.2, s: 0.85, r: 0.35 }, gain: 0.32 }) },
  flute: { label: 'Flute', icon: '🪈', render: (o, sr, s, n, f, v) => wtNote(o, sr, s, n, f, v, { key: 'flt', bright: [1, 0.25, 0.1, 0.04], vibrato: 0.003, adsr: { a: 0.06, d: 0.1, s: 0.9, r: 0.12 }, gain: 0.5 }) },
  synth: { label: 'Synth lead', icon: '🎛️', render: (o, sr, s, n, f, v) => wtNote(o, sr, s, n, f, v, { key: 'syn', bright: series(25, (h) => (h % 2 ? 1 / h : 0)), detune: 12, adsr: { a: 0.01, d: 0.15, s: 0.7, r: 0.1 }, gain: 0.32 }) },
  choir: { label: 'Choir “ooh”', icon: '🎤', render: (o, sr, s, n, f, v) => {
    const formant = (h) => { const fh = f * h; return Math.exp(-(((fh - 400) / 180) ** 2)) + 0.6 * Math.exp(-(((fh - 800) / 250) ** 2)) + 0.05 / h; };
    wtNote(o, sr, s, n, f, v, { key: 'chr' + Math.round(f), bright: series(30, formant), vibrato: 0.006, detune: 9, adsr: { a: 0.2, d: 0.2, s: 0.9, r: 0.4 }, gain: 0.4 });
  } },
  bells: { label: 'Music box', icon: '🔔', render: (o, sr, s, n, f, v) => bell(o, sr, s, n, f, v) },
  marimba: { label: 'Marimba', icon: '🪵', render: (o, sr, s, n, f, v) => bell(o, sr, s, n, f, v, [[1, 1, 0.45], [3.93, 0.25, 0.08], [9.9, 0.08, 0.03]]) },
  cowbell: { label: 'Phonk cowbell', icon: '🛎️', render: (o, sr, s, n, f, v) => cowbell(o, sr, s, n, f, v) },
  bass808: { label: '808 bass', icon: '🔊', render: (o, sr, s, n, f, v) => bass808(o, sr, s, n, f, v) },
};

/** Render notes with an instrument into a stereo pair of Float32Arrays of `length` samples. */
export function renderNotes(notes, instrument, sr, length, { octave = 0 } = {}) {
  const inst = INSTRUMENTS[instrument];
  if (!inst) throw new Error(`Unknown instrument ${instrument}`);
  const mono = new Float32Array(length);
  for (const n of notes) {
    const midi = n.midi + 12 * octave;
    if (midi < 18 || midi > 110) continue;
    inst.render(mono, sr, Math.round(n.start * sr), n, hz(midi), 0.35 + 0.65 * (n.vel ?? 0.8));
  }
  // soft limiter + a touch of stereo width
  let peak = 1e-9; for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const g = peak > 0.9 ? 0.9 / peak : 1;
  const L = new Float32Array(length), R = new Float32Array(length);
  const dly = Math.round(sr * 0.012);
  for (let i = 0; i < length; i++) { const v = mono[i] * g; L[i] = v; R[i] = 0.85 * v + 0.15 * (mono[i - dly] ?? 0) * g; }
  return [L, R];
}
