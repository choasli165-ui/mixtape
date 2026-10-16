// The DJ sampler's one-shot sounds, synthesised (no sample files, nothing to license).
export const SOUNDS = [
  { id: 'horn', label: 'Air horn', icon: '📯' },
  { id: 'siren', label: 'Siren', icon: '🚨' },
  { id: 'laser', label: 'Laser', icon: '⚡' },
  { id: 'kick', label: '808 boom', icon: '💥' },
  { id: 'clap', label: 'Clap', icon: '👏' },
  { id: 'riser', label: 'Riser', icon: '🚀' },
  { id: 'impact', label: 'Impact', icon: '🌋' },
  { id: 'down', label: 'Downlifter', icon: '🪂' },
];

function noise(seed = 1) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1; }

/** → Float32Array (mono) for sound `id` at sample rate `sr`. */
export function synth(id, sr) {
  const make = (secs) => new Float32Array(Math.round(secs * sr));
  const rnd = noise(id.length * 7919);
  let x;
  switch (id) {
    case 'horn': { // three detuned saws, three blasts
      x = make(1.25); const fs = [466.2, 469, 698.5]; const ph = [0, 0, 0];
      for (let i = 0; i < x.length; i++) {
        const t = i / sr, blast = t < 0.16 ? 0 : t < 0.3 ? 1 : t < 0.42 ? 2 : 3;
        const local = blast === 0 ? t : blast === 1 ? t - 0.16 : blast === 2 ? t - 0.3 : t - 0.42;
        const on = blast < 3 ? (local < 0.11 ? 1 : 0) : Math.max(0, Math.min(1, 1 - (local - 0.6) / 0.2));
        const bend = 1 - 0.06 * Math.exp(-local * 30);
        let v = 0; for (let k = 0; k < 3; k++) { ph[k] = (ph[k] + (fs[k] * bend) / sr) % 1; v += 2 * ph[k] - 1; }
        x[i] = Math.tanh(v * 0.9) * 0.55 * on * Math.min(1, local * 200);
      }
      break;
    }
    case 'siren': {
      x = make(1.6); let ph = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr; const f = 900 + 450 * Math.sin(2 * Math.PI * 2.2 * t); ph += f / sr; x[i] = Math.tanh(3 * Math.sin(2 * Math.PI * ph)) * 0.35 * Math.min(1, t * 40, (1.6 - t) * 6); }
      break;
    }
    case 'laser': {
      x = make(0.45); let ph = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (2600 * Math.exp(-t * 9) + 120) / sr; x[i] = Math.sin(2 * Math.PI * ph) * 0.5 * Math.exp(-t * 5); }
      break;
    }
    case 'kick': {
      x = make(1.4); let ph = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (48 + 110 * Math.exp(-t * 28)) / sr; x[i] = Math.tanh(1.6 * Math.sin(2 * Math.PI * ph)) * 0.75 * Math.exp(-t * 2.2); }
      break;
    }
    case 'clap': {
      x = make(0.5); let lp = 0, hp = 0, prev = 0;
      for (let i = 0; i < x.length; i++) {
        const t = i / sr; let env = 0;
        for (const o of [0, 0.011, 0.022]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) * (o === 0.022 ? 18 : 140)));
        const n = rnd(); lp += (n - lp) * 0.35; const b = lp - prev; prev = lp; hp = b;
        x[i] = hp * env * 1.6;
      }
      break;
    }
    case 'riser': {
      x = make(2.2); let ph = 0, lp = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr, p = t / 2.2; ph += (180 * Math.pow(12, p)) / sr; const n = rnd(); lp += (n - lp) * (0.05 + 0.9 * p); x[i] = (0.25 * Math.sin(2 * Math.PI * ph) + 0.35 * (n - lp)) * p * p * Math.min(1, (2.2 - t) * 30); }
      break;
    }
    case 'impact': {
      x = make(2.2); let ph = 0, lp = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (40 + 60 * Math.exp(-t * 12)) / sr; const n = rnd(); lp += (n - lp) * 0.08; x[i] = Math.tanh(1.4 * Math.sin(2 * Math.PI * ph)) * 0.6 * Math.exp(-t * 1.6) + lp * 1.4 * Math.exp(-t * 3); }
      break;
    }
    case 'down': {
      x = make(1.8); let lp = 0, ph = 0;
      for (let i = 0; i < x.length; i++) { const t = i / sr, p = t / 1.8; const n = rnd(); lp += (n - lp) * (0.9 - 0.85 * p); ph += (1600 * Math.pow(0.08, p)) / sr; x[i] = (0.3 * (n - lp * 0.3) * (1 - p) + 0.2 * Math.sin(2 * Math.PI * ph) * (1 - p)) * Math.min(1, t * 20); }
      break;
    }
    default: x = make(0.1);
  }
  let peak = 1e-9; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = 0.7 / peak; for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
