// Live vocal tuning engine: noise gate → pitch detection (YIN) → target note → PSOLA pitch shift → de-esser.
// Pure JS with no browser APIs, so the same code runs in the AudioWorklet and in Node tests.

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (m) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

export const DEFAULTS = {
  bypass: false,
  inputProcessing: false, // false = plain microphone (standard input, nothing added). true = the extra clean-up below
  inputGainDb: 0,       // manual mic volume (fixed gain)
  autoLevel: true,      // raise a quiet microphone automatically (up to +30 dB)
  levelTarget: -18,     // dBFS (RMS) the voice is levelled to
  couplingMax: 1,       // most music the mic can pick up (ratio): ~0.06 with headphones, ~1 with speakers
  gateDb: -60,          // noise gate threshold (dBFS, after levelling); below this the mic is muted
  mode: 'reference',    // 'reference' (follow the original singer) | 'scale' (song key) | 'off'
  tonic: 0, scale: 'major',
  strength: 0.8,        // 0..1 how far towards the target note
  speedMs: 60,          // retune time: 0 = instant ("hard tune"), 200+ = very natural
  vibrato: 0.8,         // 0..1 how much of the singer's own vibrato/expression is kept
  toleranceCents: 15,   // errors smaller than this are left alone
  refRange: 2,          // follow the song only when within this many semitones of its note (else: song key)
  refWindow: 0.25,      // seconds of timing slack when matching the song's notes
  latencyComp: 0.04,    // seconds: song time the singer hears = song clock − this
  deessAmount: 0.5,     // 0..1
  lowCut: 'auto',       // 'auto' (follows the singer's lowest notes) | 0 (off) | Hz
  hum: 'auto',          // 'auto' (detect 50/60 Hz mains hum) | 'off' | 50 | 60
  deboom: true,         // tame pops, bumps and thumps (sudden bursts of low frequencies)
  deessHz: 6000,
  minHz: 65,
};

// ------------------------------------------------------------------ pitch detection
/** Streaming YIN on a 2× decimated signal. push() samples, detect() every hop. */
export class Detector {
  constructor(sr, { minHz = 65, maxHz = 1100, threshold = 0.2 } = {}) {
    this.q = sr >= 32000 ? 2 : 1;
    this.rate = sr / this.q;
    this.maxLag = Math.ceil(this.rate / minHz);
    this.minLag = Math.max(2, Math.floor(this.rate / maxHz));
    this.W = Math.max(256, Math.ceil(this.maxLag * 1.1));
    this.N = this.W + this.maxLag + 2;
    this.size = 4096; while (this.size < this.N * 2) this.size *= 2;
    this.ring = new Float32Array(this.size); this.pos = 0; this.count = 0;
    this.x = new Float32Array(this.N); this.d = new Float32Array(this.maxLag + 2);
    this.threshold = threshold;
    this.p1 = 0; this.p2 = 0; this.phase = 0;
  }
  push(s) {
    if (this.q === 1) { this.ring[this.pos] = s; this.pos = (this.pos + 1) & (this.size - 1); this.count++; return; }
    // [¼ ½ ¼] low-pass, keep every second sample
    const y = 0.25 * this.p2 + 0.5 * this.p1 + 0.25 * s;
    this.p2 = this.p1; this.p1 = s;
    if ((this.phase ^= 1) === 0) { this.ring[this.pos] = y; this.pos = (this.pos + 1) & (this.size - 1); this.count++; }
  }
  /** → { hz, clarity 0..1, rms } (hz = 0 when no clear pitch). */
  detect() {
    const { N, W, maxLag, minLag, x, d, size } = this;
    if (this.count < N) return { hz: 0, clarity: 0, rms: 0 };
    for (let i = 0, j = (this.pos - N + size) & (size - 1); i < N; i++, j = (j + 1) & (size - 1)) x[i] = this.ring[j];
    let e = 0; for (let i = N - W; i < N; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / W);
    if (rms < 1e-4) return { hz: 0, clarity: 0, rms };
    // Difference function with early exit at the first clear dip (cheap for higher voices).
    let run = 0, best = -1, bestVal = 1, prev = 1;
    // compares the newest W samples with themselves τ earlier, so the estimate is as fresh as possible
    const diff = (tau) => { let s = 0; for (let i = N - W; i < N; i++) { const v = x[i] - x[i - tau]; s += v * v; } return s; };
    d[0] = 1;
    for (let tau = 1; tau <= maxLag; tau++) {
      const v = diff(tau); run += v;
      const c = run > 0 ? (v * tau) / run : 1;
      d[tau] = c;
      if (tau > minLag) {
        if (c < bestVal) { bestVal = c; best = tau; }
        if (prev < this.threshold && c > prev) { best = tau - 1; bestVal = prev; break; } // left the dip
      }
      prev = c;
    }
    if (best < minLag + 1 || bestVal > 0.45) return { hz: 0, clarity: 1 - bestVal, rms };
    // parabolic interpolation
    const a = d[best - 1], b = d[best], c = best + 1 <= maxLag ? d[best + 1] : b;
    const den = a - 2 * b + c;
    const t = den > 1e-9 ? best + (0.5 * (a - c)) / den : best;
    return { hz: this.rate / t, clarity: 1 - bestVal, rms };
  }
}

// ------------------------------------------------------------------ target notes
/** Find the note to tune towards, from the song's melody or from the key. */
export function scaleTarget(midi, tonic, scale = 'major') {
  const pcs = SCALES[scale] || SCALES.chromatic;
  let best = Math.round(midi), bd = Infinity;
  for (let k = Math.floor(midi) - 2; k <= Math.ceil(midi) + 2; k++) {
    const pc = (((k - tonic) % 12) + 12) % 12;
    if (!pcs.includes(pc)) continue;
    const dd = Math.abs(k - midi);
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

/** Index of the first note that ends after time t (notes sorted by start). */
function firstAfter(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (notes[m].start + notes[m].dur + 2 < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Song note near time t, octave-folded to the singer. → { midi, ref } or null */
export function referenceTarget(midi, notes, t, { window = 0.25, range = 3 } = {}) {
  if (!notes?.length || !(t >= 0)) return null;
  let best = null, bestCost = Infinity;
  for (let i = firstAfter(notes, t - window); i < notes.length; i++) {
    const n = notes[i];
    if (n.start > t + window) break;
    const gap = t < n.start ? n.start - t : t > n.start + n.dur ? t - (n.start + n.dur) : 0;
    if (gap > window) continue;
    const folded = n.midi + 12 * Math.round((midi - n.midi) / 12); // singing an octave up/down is fine
    const dist = Math.abs(folded - midi);
    const cost = dist + gap * 4;
    if (cost < bestCost) { bestCost = cost; best = { midi: folded, ref: n.midi, dist }; }
  }
  return best && best.dist <= range ? best : null;
}

/** Turns detected pitch into a smooth pitch-shift amount (semitones). */
export class Corrector {
  constructor(settings = DEFAULTS) { this.s = { ...DEFAULTS, ...settings }; this.reset(); }
  reset() { this.target = NaN; this.center = NaN; this.shift = 0; this.hist = []; this.source = ''; }
  set(settings) { Object.assign(this.s, settings); }
  /** midi: detected pitch (NaN = unvoiced); dt: seconds since last update; t: song time (s) or NaN. */
  update(midi, dt, t, notes) {
    const s = this.s;
    if (!Number.isFinite(midi)) {
      this.hist.length = 0; this.center = NaN; this.target = NaN; this.source = '';
      this.shift *= Math.exp(-dt / 0.03);
      return { shift: this.shift, target: NaN, midi: NaN, source: '' };
    }
    // median of 3 removes single-frame octave slips
    this.hist.push(midi); if (this.hist.length > 3) this.hist.shift();
    const h = this.hist;
    const m = h.length === 3 && Math.max(...h) - Math.min(...h) > 0.8 ? [...h].sort((a, b) => a - b)[1] : midi;
    const onset = !Number.isFinite(this.center);
    this.center = onset ? m : this.center + (m - this.center) * (1 - Math.exp(-dt / 0.12));

    let target = NaN, source = '';
    if (s.mode === 'reference') {
      const r = referenceTarget(m, notes, t, { window: s.refWindow, range: s.refRange });
      if (r) { target = r.midi; source = 'song'; }
    }
    if (!Number.isFinite(target) && s.mode !== 'off') {
      const cand = scaleTarget(m, s.tonic, s.scale);
      // hysteresis: don't flip between two neighbouring notes while sliding
      target = this.source === 'key' && Number.isFinite(this.target) && Math.abs(m - this.target) - Math.abs(m - cand) < 0.2 ? this.target : cand;
      source = 'key';
    }
    this.target = target; this.source = source;
    let desired = 0;
    if (Number.isFinite(target)) {
      const base = s.vibrato * this.center + (1 - s.vibrato) * m;
      const err = target - base, tol = s.toleranceCents / 100;
      const e = Math.sign(err) * Math.max(0, Math.abs(err) - tol);
      desired = Math.max(-7, Math.min(7, e * s.strength));
    }
    const tau = s.speedMs / 1000;
    this.shift = tau <= 0.001 ? desired : this.shift + (desired - this.shift) * (1 - Math.exp(-dt / tau));
    return { shift: this.shift, target, midi: m, source };
  }
}

// ------------------------------------------------------------------ PSOLA pitch shifter
/**
 * Streaming time-domain PSOLA. Grains two periods long are taken one input period apart and laid down
 * one *output* period apart, so pitch changes while the voice's timbre (formants) stays the same.
 * Latency D = 2 × grain half-length; it adapts to the singer's voice during pauses.
 */
export class Psola {
  constructor(sr, { minHz = 65 } = {}) {
    this.sr = sr;
    this.size = 8192; this.M = this.size - 1;
    this.inp = new Float32Array(this.size); this.acc = new Float32Array(this.size); this.ws = new Float32Array(this.size);
    this.w = 0;
    this.Dcap = Math.ceil((2 * sr) / minHz) + 16;
    this.Dmin = Math.round(sr * 0.004);
    this.D = Math.min(this.Dcap, Math.ceil((2.2 * sr) / 110)); // until we know the voice
    this.need = 0; this.quiet = 0; this.active = false; this.p = 0; this.inMark = 0;
    this.T = 0; this.r = 1;
  }
  /** period in samples (0 = unvoiced), ratio = output/input frequency */
  setPitch(period, ratio) {
    this.T = period; this.r = ratio;
    if (period > 0) this.need = Math.max(this.need * 0.9995, 2 * Math.ceil(period / Math.min(1, ratio)) + 8);
  }
  latency() { return this.D; }
  process(x) {
    const { M, inp, acc, ws } = this;
    const w = this.w;
    inp[w & M] = x;
    if (this.T > 0) {
      const T = this.T, To = T / this.r, H = Math.min(To, (this.D - 4) / 2);
      if (!this.active) { this.active = true; this.p = w - H; this.inMark = this.p; }
      this.quiet = 0;
      while (this.p + H <= w) {
        while (this.inMark + T <= this.p) this.inMark += T;
        const pc = Math.round(this.p), cc = Math.round(this.inMark), Hi = Math.floor(H);
        const k = Math.PI / H;
        for (let j = -Hi; j <= Hi; j++) {
          const wv = 0.5 + 0.5 * Math.cos(j * k);
          const o = (pc + j) & M;
          acc[o] += inp[(cc + j) & M] * wv; ws[o] += wv;
        }
        this.p += To;
      }
    } else if (this.active) { this.active = false; }
    else if (++this.quiet > this.D + 8 && this.need > 0) {
      // pause: adapt latency to the singer's voice (all pending grains have been played)
      const want = Math.max(this.Dmin, Math.min(this.Dcap, Math.ceil(this.need) + 24));
      if (Math.abs(want - this.D) > 16) { this.D = want; acc.fill(0); ws.fill(0); }
      this.quiet = 0;
    }
    const n = (w - this.D) & M;
    const a = acc[n], s = ws[n], direct = inp[n];
    acc[n] = 0; ws[n] = 0;
    this.w = w + 1;
    return s >= 1 ? a / s : a + direct * (1 - s);
  }
}

// ------------------------------------------------------------------ clean-up filters
/** RBJ biquad (direct form I). */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(type, f, Q, sr) {
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else { b0 = 1; b1 = -2 * c; b2 = 1; } // notch
    a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
/** Power of one frequency in a block (Goertzel). */
function goertzel(buf, n, f, sr) {
  const k = 2 * Math.cos((2 * Math.PI * f) / sr); let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = buf[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n);
}

// ------------------------------------------------------------------ whole voice processor
export class VocalTuner {
  constructor(sr, settings = {}) {
    this.sr = sr;
    this.s = { ...DEFAULTS, ...settings };
    this.det = new Detector(sr, { minHz: this.s.minHz });
    this.cor = new Corrector(this.s);
    this.ps = new Psola(sr, { minHz: this.s.minHz });
    this.hop = 256; this.k = 0;
    this.env = 0; this.gate = 0; this.gateOpen = false;
    // voice activity: room noise floor, music bleeding in from speakers, automatic level
    this.ms = 0; this.floor = -1; this.floorRing = []; this.pitchy = false; this.coupling = -1; this.musicRms = 0; this.bleed = 0; this.vad = false;
    this.agc = 1; this.gNow = 1; this.voicedHops = 0;
    this.hpPrev = 0; this.hpOut = 0; this.sEnv = 0; this.fEnv = 0;
    // clean-up: 24 dB/octave low cut, mains-hum notches, thump guard
    this.hp1 = new Biquad(); this.hp2 = new Biquad(); this.cutHz = 0; this.lows = [];
    this.notches = []; this.humHz = 0; this.humBuf = new Float32Array(Math.round(sr * 0.5)); this.humN = 0; this.humVotes = { 50: 0, 60: 0 };
    this.bLp1 = new Biquad().set('lp', 160, 0.707, sr); this.bLp2 = new Biquad().set('lp', 160, 0.707, sr); this.bEnvL = 0; this.bEnvF = 0; this.bG = 1;
    this.notes = []; this.clock = null;
    this.last = { midi: NaN, target: NaN, shift: 0, source: '', rms: 0, clarity: 0 };
    this.applySettings();
  }
  set(settings) { Object.assign(this.s, settings); this.cor.set(settings); this.applySettings(); }
  applySettings() {
    const s = this.s;
    this.setLowCut(s.lowCut === 'auto' ? (this.cutHz || 75) : Number(s.lowCut) || 0);
    if (s.hum === 'off') this.setHum(0); else if (s.hum === 50 || s.hum === 60 || s.hum === '50' || s.hum === '60') this.setHum(Number(s.hum));
    this.inGain = Math.pow(10, s.inputGainDb / 20);
    this.gateThr = Math.pow(10, s.gateDb / 20);
    this.levelTarget = Math.pow(10, s.levelTarget / 20);
    if (!s.autoLevel) this.agc = 1;
    this.hpA = Math.exp((-2 * Math.PI * s.deessHz) / this.sr);
  }
  setLowCut(hz) {
    hz = Math.round(hz);
    if (hz === this.cutHz) return;
    this.cutHz = hz;
    if (hz > 0) { this.hp1.set('hp', hz, 0.541, this.sr); this.hp2.set('hp', hz, 1.307, this.sr); } // 4th-order Butterworth
  }
  setHum(hz) {
    if (hz === this.humHz) return;
    this.humHz = hz;
    this.notches = hz ? [1, 2, 3, 4].map((k) => new Biquad().set('notch', hz * k, 18, this.sr)) : [];
  }
  /** Listen for mains hum while the singer is quiet: a narrow peak at 50/100 Hz or 60/120 Hz. */
  detectHum() {
    const b = this.humBuf, n = this.humN, sr = this.sr;
    const p = (f) => goertzel(b, n, f, sr);
    const ref = (p(40) + p(72) + p(88) + p(140)) / 4 + 1e-14;
    for (const f of [50, 60]) {
      const r = (p(f) + p(2 * f)) / 2 / ref;
      this.humVotes[f] = r > 12 ? this.humVotes[f] + 1 : Math.max(0, this.humVotes[f] - 1);
    }
    if (this.s.hum === 'auto') {
      if (this.humVotes[50] >= 3 && this.humVotes[50] >= this.humVotes[60]) this.setHum(50);
      else if (this.humVotes[60] >= 3) this.setHum(60);
    }
  }
  /** Song position the singer is hearing at context time `now`. */
  songTime(now) {
    const c = this.clock;
    if (!c || !c.playing) return NaN;
    return c.songTime + (now - c.ctxTime) * (c.rate || 1) - this.s.latencyComp;
  }
  /** Process one block. now = context time (s) of the block's first sample. Returns pitch frames detected. */
  process(input, output, now) {
    const s = this.s, frames = [];
    const atk = 1 - Math.exp(-1 / (0.001 * this.sr)), rel = 1 - Math.exp(-1 / (0.12 * this.sr));
    const gAtk = 1 - Math.exp(-1 / (0.003 * this.sr)), gRel = 1 - Math.exp(-1 / (0.08 * this.sr));
    const sAtk = 1 - Math.exp(-1 / (0.0015 * this.sr)), sRel = 1 - Math.exp(-1 / (0.04 * this.sr));
    const msK = 1 - Math.exp(-1 / (0.15 * this.sr)), gK = 1 - Math.exp(-1 / (0.02 * this.sr));
    for (let i = 0; i < input.length; i++) {
      let x = input[i] * this.inGain;
      const proc = s.inputProcessing;
      // optional clean-up before any gain: hum notches, steep low cut, thump guard
      if (proc && !this.pitchy && this.humN < this.humBuf.length) this.humBuf[this.humN++] = x;
      if (proc) for (const nf of this.notches) x = nf.process(x);
      if (proc && this.cutHz > 0) x = this.hp2.process(this.hp1.process(x));
      if (proc && s.deboom) {
        const lo = this.bLp2.process(this.bLp1.process(x));
        const al = Math.abs(lo), af = Math.abs(x);
        this.bEnvL += (al - this.bEnvL) * (al > this.bEnvL ? 0.02 : 0.0008);
        this.bEnvF += (af - this.bEnvF) * (af > this.bEnvF ? 0.02 : 0.0008);
        // when the lows suddenly dominate (a "p", a bump on the stand), duck just the lows
        const want = this.bEnvL > 0.6 * this.bEnvF && this.bEnvL > 0.003 ? Math.max(0.25, (0.6 * this.bEnvF) / this.bEnvL) : 1;
        this.bG += (want - this.bG) * (want < this.bG ? 0.01 : 0.0005);
        x -= lo * (1 - this.bG);
      }
      this.ms += (x * x - this.ms) * msK;
      // automatic level (smoothed per sample)
      if (proc) { this.gNow += (this.agc - this.gNow) * gK; x *= this.gNow; }
      // noise gate with hysteresis; the threshold rises with room noise and music bleed
      const a = Math.abs(x);
      this.env += (a - this.env) * (a > this.env ? atk : rel);
      const thr = proc ? this.thr || this.gateThr : this.gateThr;
      if (this.gateOpen ? this.env < thr * 0.6 : this.env > thr) this.gateOpen = !this.gateOpen;
      if (proc) { // the gate only mutes the mic when clean-up is on; otherwise it just tells "is someone singing"
        this.gate += ((this.gateOpen ? 1 : 0) - this.gate) * (this.gateOpen ? gAtk : gRel);
        x *= this.gate;
      }
      this.det.push(x);
      if (++this.k >= this.hop) {
        this.k = 0;
        this.updateActivity();
        const d = this.det.detect();
        this.pitchy = d.hz > 70 && d.clarity > 0.85;
        const voiced = d.hz > 0 && d.clarity > 0.75 && this.gateOpen && this.vad;
        const t = now + i / this.sr;
        const song = this.songTime(t);
        const r = s.bypass || s.mode === 'off'
          ? { shift: 0, target: NaN, midi: voiced ? hzToMidi(d.hz) : NaN, source: '' }
          : this.cor.update(voiced ? hzToMidi(d.hz) : NaN, this.hop / this.sr, song, this.notes);
        this.ps.setPitch(voiced ? this.sr / d.hz : 0, Math.pow(2, r.shift / 12));
        this.last = { midi: r.midi, target: r.target, shift: r.shift, source: r.source, rms: d.rms, clarity: d.clarity };
        frames.push({ t, song, midi: r.midi, target: r.target, shift: r.shift, source: r.source, rms: d.rms, vad: this.vad });
      }
      let y = s.bypass || s.mode === 'off' ? x : this.ps.process(x);
      // de-esser: tame the sharp "s/sh" band when it dominates
      if (s.deessAmount > 0) {
        this.hpOut = this.hpA * (this.hpOut + y - this.hpPrev); this.hpPrev = y;
        const h = Math.abs(this.hpOut), f = Math.abs(y);
        this.sEnv += (h - this.sEnv) * (h > this.sEnv ? sAtk : sRel);
        this.fEnv += (f - this.fEnv) * (f > this.fEnv ? sAtk : sRel);
        const ratio = this.sEnv / (this.fEnv + 1e-6);
        if (ratio > 0.3) { const g = Math.max(1 - s.deessAmount * 0.85, 0.3 / ratio); y = y - this.hpOut * (1 - g); }
      }
      // soft limiter: loud notes round off instead of clipping
      const ay = Math.abs(y);
      if (proc && ay > 0.8) y = Math.sign(y) * (0.8 + 0.2 * Math.tanh((ay - 0.8) / 0.2));
      output[i] = y;
    }
    return frames;
  }
  /** Music level currently playing (RMS, as sent to the speakers/headphones). */
  setMusicLevel(rms) { this.musicRms = rms; }
  /**
   * Once per hop: is the singer actually singing? Compares the microphone with
   *  - the room's noise floor (fans, hum, distant chatter), tracked as a slowly rising minimum, and
   *  - the music leaking from speakers into the microphone: the lowest mic/music ratio seen recently
   *    is the acoustic coupling, so coupling × music level = expected bleed.
   * Then levels the voice automatically (only while singing, so noise is never pumped up).
   */
  updateActivity() {
    if (!this.s.inputProcessing) { // plain input: singing = clearly above silence, nothing adaptive
      this.vad = Math.sqrt(this.ms) > 3e-4; this.agc = 1; this.bleed = 0; this.thr = 0;
      return;
    }
    if (this.humN >= this.humBuf.length) { if (this.s.hum !== 'off') this.detectHum(); this.humN = 0; }
    // automatic low cut: just under the lowest notes the singer actually uses (70–140 Hz)
    if (this.s.lowCut === 'auto' && Number.isFinite(this.last.midi)) {
      const hz = 440 * Math.pow(2, (this.last.midi - 69) / 12);
      this.lows.push(hz); if (this.lows.length > 400) this.lows.shift();
      if (this.lows.length % 40 === 0) {
        const sorted = [...this.lows].sort((a, b) => a - b), low = sorted[Math.floor(sorted.length * 0.05)];
        this.setLowCut(Math.max(70, Math.min(140, low * 0.72)));
      }
    }
    const rms = Math.sqrt(this.ms);
    // noise floor = quietest moment of the last ~3 s, counting only moments without a sung pitch
    this.hops = (this.hops || 0) + 1;
    if (!this.pitchy && this.hops > 20) { this.floorRing.push(rms); if (this.floorRing.length > 560) this.floorRing.shift(); }
    if (this.floorRing.length && this.hops % 10 === 0) {
      let m = Infinity; for (const v of this.floorRing) if (v < m) m = v;
      if (m < this.floor || this.floorRing.length >= 140) this.floor = m; // only rise with enough evidence
    }
    if (this.floor < 0) this.floor = Math.max(rms, 1e-5);
    this.floor = Math.max(this.floor, 1e-5);
    this.mSm = (this.mSm || 0) + (this.musicRms - (this.mSm || 0)) * (1 - Math.exp(-this.hop / this.sr / 0.15));
    const m = this.mSm;
    if (m > 0.003) {
      const r = rms / m;
      const cap = this.s.couplingMax;
      if (this.coupling < 0) this.coupling = Math.min(r, cap * 0.3); // start from a modest guess
      else if (r < this.coupling) this.coupling += (r - this.coupling) * 0.08;
      else this.coupling = Math.min(cap, this.coupling * 1.0001);
      this.bleed = this.coupling * m;
    } else this.bleed = 0;
    this.vad = rms > 2.5e-4 && rms > this.floor * 3.2 && rms > this.bleed * 2.2;
    if (this.s.autoLevel && this.vad) {
      const want = Math.max(1, Math.min(31.6, this.levelTarget / rms));
      const tau = want < this.agc ? 0.15 : 1.2;
      this.agc += (want - this.agc) * (1 - Math.exp(-this.hop / this.sr / tau));
    }
    // the gate opens only above noise and bleed (both measured before levelling)
    this.thr = Math.max(this.gateThr, (Math.max(this.floor * 2.5, this.bleed * 1.8)) * this.agc);
  }
}
