// DJ Mode: a two-deck controller. Scratchable turntables, a 2-channel mixer with EQ/filter/faders,
// performance pads (hot cues, loop rolls, beat jumps, sampler), per-deck FX, loops, sync and transitions.
import { t } from '/i18n.js';
import { audio, loadMix, analyzeTrack, peaksOf, drawWave, fmtTime, hexA, saveInspiration } from './core.js';
import { SOUNDS, synth } from '/dsp/dj-sounds.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { A: '#ff7a45', B: '#39c6d6' };
const SEC_PER_REV = 1.8; // 33⅓ rpm: one turn of the platter = 1.8 s of music
const PAD_COLORS = ['#ff5d7a', '#ffb36b', '#e6c84f', '#7fd18b', '#39c6d6', '#7b5cff', '#d17bff', '#ff8f6b'];
const ROLLS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
const JUMPS = [-16, -8, -4, -1, 1, 4, 8, 16];
const LOOP_SIZES = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const FX = { echo: 'Echo', reverb: 'Reverb', flanger: 'Flanger', crush: 'Crush', gate: 'Gate' };
const FX_BEATS = [1 / 4, 1 / 2, 1, 2, 4];
const frac = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);
const KEYS_A = ['1', '2', '3', '4', '5', '6', '7', '8'], KEYS_B = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i'];

let workletP = null, workletCtx = null;
function ensureDJWorklet(c) {
  if (workletCtx !== c) { workletCtx = c; workletP = c.audioWorklet.addModule('/dsp/dj-worklet.js'); }
  return workletP;
}
function impulse(c, secs = 2.4) {
  const len = Math.round(secs * c.sampleRate), b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  return b;
}
function crushCurve(bits = 5) {
  const n = 4096, cv = new Float32Array(n), st = Math.pow(2, bits);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; cv[i] = Math.round(x * st) / st; }
  return cv;
}

// ------------------------------------------------------------------ one deck: turntable + channel strip + FX
class Deck {
  constructor(c, out, side) {
    this.c = c; this.side = side;
    this.node = new AudioWorkletNode(c, 'dj-deck', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.trim = c.createGain();
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.8;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 3500;
    this.filter = c.createBiquadFilter(); this.filter.type = 'allpass'; this.filter.Q.value = 1.4;
    this.fxIn = c.createGain(); this.dry = c.createGain(); this.fxOut = c.createGain();
    // FX paths (only the chosen one gets signal)
    this.eDelay = c.createDelay(4); this.eFb = c.createGain(); this.eLp = c.createBiquadFilter(); this.eLp.type = 'lowpass'; this.eLp.frequency.value = 5500; this.eWet = c.createGain();
    this.fxIn.connect(this.eDelay); this.eDelay.connect(this.eLp).connect(this.eFb).connect(this.eDelay); this.eLp.connect(this.eWet).connect(this.fxOut);
    this.conv = c.createConvolver(); this.conv.buffer = impulse(c); this.rWet = c.createGain();
    this.fxIn.connect(this.conv).connect(this.rWet).connect(this.fxOut);
    this.fDelay = c.createDelay(0.05); this.fDelay.delayTime.value = 0.003; this.fFb = c.createGain(); this.fFb.gain.value = 0.6; this.fWet = c.createGain();
    this.fLfo = c.createOscillator(); this.fDepth = c.createGain(); this.fDepth.gain.value = 0.0022; this.fLfo.connect(this.fDepth).connect(this.fDelay.delayTime); this.fLfo.start();
    this.fxIn.connect(this.fDelay); this.fDelay.connect(this.fFb).connect(this.fDelay); this.fDelay.connect(this.fWet).connect(this.fxOut);
    this.cShaper = c.createWaveShaper(); this.cShaper.curve = crushCurve(); this.cLp = c.createBiquadFilter(); this.cLp.type = 'lowpass'; this.cLp.frequency.value = 4200; this.cWet = c.createGain();
    this.fxIn.connect(this.cShaper).connect(this.cLp).connect(this.cWet).connect(this.fxOut);
    this.gAmp = c.createGain(); this.gAmp.gain.value = 0.5; this.gLfo = c.createOscillator(); this.gLfo.type = 'square'; this.gSmooth = c.createBiquadFilter(); this.gSmooth.type = 'lowpass'; this.gSmooth.frequency.value = 120;
    this.gDepth = c.createGain(); this.gDepth.gain.value = 0.5; this.gLfo.connect(this.gSmooth).connect(this.gDepth).connect(this.gAmp.gain); this.gLfo.start(); this.gWet = c.createGain();
    this.fxIn.connect(this.gAmp).connect(this.gWet).connect(this.fxOut);
    for (const w of [this.eWet, this.rWet, this.fWet, this.cWet, this.gWet]) w.gain.value = 0;
    this.fxIn.connect(this.dry).connect(this.fxOut);
    // transition echo-out
    this.tDelay = c.createDelay(2); this.tFb = c.createGain(); this.tFb.gain.value = 0; this.tEcho = c.createGain(); this.tEcho.gain.value = 0;
    this.fader = c.createGain(); this.xf = c.createGain(); this.meter = c.createAnalyser(); this.meter.fftSize = 1024;
    this.node.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.filter).connect(this.fxIn);
    this.filter.connect(this.tDelay); this.tDelay.connect(this.tFb).connect(this.tDelay); this.tDelay.connect(this.tEcho).connect(this.fader);
    this.fxOut.connect(this.fader); this.fader.connect(this.xf).connect(this.meter).connect(out);
    this.meterBuf = new Float32Array(1024);
    this.st = { pos: 0, vel: 0, playing: false, t: 0 };
    this.node.port.onmessage = (e) => { const m = e.data; if (m.type !== 'pos') return; this.st = m; if (m.ended) this.onEnded?.(); };
    this.buffer = null; this.rate = 1; this.range = 8; this.bendV = 0;
    this.eq = { low: 0, mid: 0, high: 0 }; this.kill = { low: false, mid: false, high: false }; this.filt = 0; this.trimV = 1; this.faderV = 1;
    this.cue = 0; this.hot = Array(8).fill(null); this.loop = null; this.lastLoop = null; this.loopSize = 4; this.loopIn = null; this.roll = null;
    this.q = true; this.slip = false; this.vinyl = true; this.brake = false; this.rev = false; this.syncLock = false;
    this.fx = { type: 'echo', beats: 1 / 2, amount: 0.5, on: false }; this.padMode = 'hot';
  }
  post(m, tr) { this.node.port.postMessage(m, tr || []); }
  load(track, buffer, an) {
    const L = buffer.getChannelData(0).slice(), R = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
    this.post({ type: 'load', L, R, sr: buffer.sampleRate, at: an.downbeat }, [L.buffer, R.buffer]);
    this.st = { pos: an.downbeat, vel: 0, playing: false, t: this.c.currentTime };
    this.track = track; this.buffer = buffer; this.an = an; this.cue = an.downbeat;
    this.peaks = peaksOf(buffer, 1400);
    this.zoom = peaksOf(buffer, Math.ceil(buffer.duration * 120));
    let zm = 1e-6; for (let i = 0; i < this.zoom.length; i++) zm = Math.max(zm, Math.abs(this.zoom[i])); this.zmax = zm;
    this.loop = null; this.lastLoop = null; this.roll = null; this.loopIn = null; this.post({ type: 'loop', loop: null });
    this.setRate(1); this.syncLock = false; this.rev = false; this.post({ type: 'rev', on: false });
    // hot cues start out on the song's sections (intro, drop, …)
    this.hot = Array(8).fill(null);
    const seen = new Set();
    for (const s of an.sections || []) {
      const at = this.snap(s.start);
      if (seen.has(at.toFixed(2)) || this.hot.filter(Boolean).length >= 8) continue;
      seen.add(at.toFixed(2)); this.hot[this.hot.indexOf(null)] = { t: at, label: s.label };
    }
    this.applyFx();
  }
  get beat() { return 60 / this.an.bpm; }
  get bpm() { return this.an ? this.an.bpm * this.rate * (1 + this.bendV) : 0; }
  get playing() { return this.st.playing; }
  get dur() { return this.buffer?.duration || 0; }
  time() { const s = this.st; return Math.max(0, Math.min(this.dur, s.pos + Math.max(0, this.c.currentTime - s.t) * s.vel)); }
  play(opts = {}) { if (opts.at == null && this.time() >= this.dur - 0.05) opts = { ...opts, at: this.cue }; this.post({ type: 'play', startup: this.brake ? 0.45 : 0.004, ...opts }); this.st = { ...this.st, playing: true }; }
  pause() { this.post({ type: 'pause', brake: this.brake ? 0.8 : 0.004 }); this.st = { ...this.st, playing: false, vel: this.brake ? this.st.vel : 0, pos: this.time(), t: this.c.currentTime }; }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(tt) { tt = Math.max(0, Math.min(this.dur - 0.05, tt)); this.post({ type: 'seek', t: tt }); this.st = { ...this.st, pos: tt, t: this.c.currentTime }; }
  setRate(r) { this.rate = r; this.post({ type: 'rate', r }); this.applyFx(); }
  bend(v) { this.bendV = v; this.post({ type: 'bend', v }); }
  snap(tt) { const b = this.beat, d = this.an.downbeat; return d + Math.round((tt - d) / b) * b; }
  floorBeat(tt, size = 1) { const b = this.beat * size, d = this.an.downbeat; return d + Math.floor((tt - d) / b + 1e-6) * b; }
  phase(tt = this.time()) { return ((((tt - this.an.downbeat) / this.beat) % 1) + 1) % 1; }
  nextBeat(whenCtx, every = 1) {
    const pos = this.time() + (whenCtx - this.c.currentTime) * this.rate;
    const n = Math.ceil((pos - this.an.downbeat) / (this.beat * every) - 1e-6);
    return whenCtx + (this.an.downbeat + n * this.beat * every - pos) / this.rate;
  }
  /** Jump; with quantize on, the beat phase is kept so a synced deck stays in time. */
  jumpTo(tt) {
    if (this.q && this.playing) { const now = this.time(); tt = this.snap(tt) + (now - this.floorBeat(now)); }
    this.seek(tt);
  }
  setLoop(loop) { this.loop = loop; if (loop) this.lastLoop = loop; this.post({ type: 'loop', loop: this.roll || loop }); }
  applyEq() {
    const t0 = this.c.currentTime;
    for (const b of ['low', 'mid', 'high']) this[b].gain.setTargetAtTime(this.kill[b] ? -40 : this.eq[b], t0, 0.02);
    this.trim.gain.setTargetAtTime(this.trimV, t0, 0.02);
    this.fader.gain.setTargetAtTime(this.faderV * this.faderV, t0, 0.015);
    const f = this.filt;
    if (Math.abs(f) < 0.03) this.filter.type = 'allpass';
    else if (f < 0) { this.filter.type = 'lowpass'; this.filter.frequency.setTargetAtTime(20000 * Math.pow(0.012, -f), t0, 0.03); }
    else { this.filter.type = 'highpass'; this.filter.frequency.setTargetAtTime(20 * Math.pow(250, f), t0, 0.03); }
  }
  applyFx() {
    if (!this.an) return;
    const t0 = this.c.currentTime, fx = this.fx, a = fx.on ? fx.amount : 0;
    const beatReal = this.beat / this.rate, len = fx.beats * beatReal;
    const set = (p, v) => p.setTargetAtTime(v, t0, 0.02);
    set(this.eWet.gain, fx.type === 'echo' ? a * 0.8 : 0); set(this.eFb.gain, fx.type === 'echo' && fx.on ? 0.35 + 0.3 * fx.amount : 0);
    this.eDelay.delayTime.setTargetAtTime(Math.min(3.9, len), t0, 0.05);
    set(this.rWet.gain, fx.type === 'reverb' ? a * 1.1 : 0);
    set(this.fWet.gain, fx.type === 'flanger' ? a * 0.8 : 0); this.fLfo.frequency.setTargetAtTime(1 / Math.max(0.05, len * 4), t0, 0.05);
    set(this.cWet.gain, fx.type === 'crush' ? a : 0);
    set(this.gWet.gain, fx.type === 'gate' ? a : 0); this.gLfo.frequency.setTargetAtTime(1 / Math.max(0.03, len), t0, 0.05);
    set(this.dry.gain, fx.on && (fx.type === 'crush' || fx.type === 'gate') ? 1 - fx.amount : 1);
  }
  level() { this.meter.getFloatTimeDomainData(this.meterBuf); let p = 0; for (const v of this.meterBuf) p = Math.max(p, Math.abs(v)); return p; }
}

// ------------------------------------------------------------------ knob widget
function knobHTML(id, label, { min, max, value, def = value, bipolar = false, small = false } = {}) {
  return `<div class="kn ${small ? 'sm' : ''}" data-kn="${id}" data-min="${min}" data-max="${max}" data-def="${def}" data-bip="${bipolar ? 1 : 0}" data-v="${value}" title="Drag up or down · double-click to reset">
    <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" class="kn-bg"/><path class="kn-arc"/><circle cx="20" cy="20" r="11" class="kn-cap"/><line x1="20" y1="20" x2="20" y2="11" class="kn-ptr"/></svg>
    <span>${label}</span></div>`;
}
function paintKnob(el, v) {
  const min = +el.dataset.min, max = +el.dataset.max, bip = el.dataset.bip === '1';
  el.dataset.v = v;
  const p = (v - min) / (max - min), ang = -135 + p * 270;
  const a0 = bip ? 0 : -135, a1 = ang;
  const pt = (a) => { const r = (a - 90) * Math.PI / 180; return `${20 + 15 * Math.cos(r)} ${20 + 15 * Math.sin(r)}`; };
  const [s, e] = a0 <= a1 ? [a0, a1] : [a1, a0];
  el.querySelector('.kn-arc').setAttribute('d', Math.abs(e - s) < 0.5 ? '' : `M ${pt(s)} A 15 15 0 ${e - s > 180 ? 1 : 0} 1 ${pt(e)}`);
  el.querySelector('.kn-ptr').setAttribute('transform', `rotate(${ang} 20 20)`);
}

// ------------------------------------------------------------------ the DJ view
export async function createDJ(el, shell) {
  const { ctx, master } = audio();
  await ensureDJWorklet(ctx);
  let destroyed = false, raf = 0, xf = -1, xcurve = 'smooth', auto = null;
  const djOut = ctx.createGain(); djOut.connect(master.input);
  const decks = { A: new Deck(ctx, djOut, 'A'), B: new Deck(ctx, djOut, 'B') };
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const samplerGain = ctx.createGain(); samplerGain.gain.value = 0.8; samplerGain.connect(djOut);
  const sampleBufs = {};
  const recDest = ctx.createMediaStreamDestination(); master.analyser.connect(recDest);
  let recorder = null, chunks = [], recStart = 0;
  const meterBuf = new Float32Array(2048);

  const setXf = (v) => { // −1 = A only, +1 = B only
    xf = Math.max(-1, Math.min(1, v));
    const p = (xf + 1) / 2;
    const [a, b] = xcurve === 'cut' ? [Math.min(1, (1 - p) * 14), Math.min(1, p * 14)] : [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
    decks.A.xf.gain.setTargetAtTime(a, ctx.currentTime, 0.008);
    decks.B.xf.gain.setTargetAtTime(b, ctx.currentTime, 0.008);
  };
  setXf(-1);

  async function loadDeck(side, track) {
    const d = decks[side];
    const box = el.querySelector(`[data-deck="${side}"]`);
    if (box) box.classList.add('loading');
    try {
      const buf = await loadMix(track);
      const an = await analyzeTrack(track, buf);
      if (destroyed) return;
      if (d.playing) d.pause();
      d.load(track, buf, an);
    } catch (e) { shell.toast(e.message, true); }
    render();
  }

  // ---------------------------------------------------------------- sync & transitions
  function sync(side, { phase = true } = {}) {
    const d = decks[side], o = decks[other(side)];
    if (!d.an || !o.an) { shell.toast('Load both decks first'); return false; }
    const target = o.an.bpm * o.rate;
    const r = [target / d.an.bpm, (target * 2) / d.an.bpm, target / 2 / d.an.bpm].sort((a, b) => Math.abs(Math.log(a)) - Math.abs(Math.log(b)))[0];
    while (Math.abs(r - 1) * 100 > d.range && d.range < 50) d.range = d.range === 8 ? 16 : 50;
    d.setRate(r);
    if (!phase) return true;
    if (o.playing && d.playing) { // line the beats up
      let dp = o.phase() - d.phase(); if (dp > 0.5) dp -= 1; if (dp < -0.5) dp += 1;
      d.seek(d.time() + dp * d.beat);
    } else if (o.playing && !d.playing) {
      d.play({ at: d.snap(d.time()), when: o.nextBeat(ctx.currentTime + 0.06, 1) });
    }
    return true;
  }
  function transition(kind) {
    const fromSide = xf <= 0 ? 'A' : 'B', toSide = other(fromSide);
    const from = decks[fromSide], to = decks[toSide];
    if (!from.playing || !to.buffer) return shell.toast(`Start deck ${fromSide} and load deck ${toSide} first`);
    if (!to.playing) to.seek(to.cue);
    sync(toSide); to.syncLock = true;
    const beat = 60 / from.bpm;
    const start = from.nextBeat(ctx.currentTime + 0.05, 4);
    const bars = { blend: 8, echo: 2, filter: 8, cut: 0 }[kind];
    const end = start + bars * 4 * beat;
    const target = toSide === 'B' ? 1 : -1, origin = xf;
    to.kill.low = kind === 'blend'; to.applyEq();
    auto = { start, end, kind, from, to, target, origin };
    if (kind === 'echo') {
      const t0 = ctx.currentTime;
      from.tDelay.delayTime.setValueAtTime(Math.min(1.9, beat * 0.75), t0);
      from.tFb.gain.setValueAtTime(0, t0); from.tFb.gain.linearRampToValueAtTime(0.6, start);
      from.tEcho.gain.setValueAtTime(0, t0); from.tEcho.gain.linearRampToValueAtTime(0.8, start);
      from.fader.gain.setValueAtTime(from.faderV ** 2, start); from.fader.gain.linearRampToValueAtTime(0, start + beat * 4);
    }
    shell.toast({ blend: 'Smooth blend over 8 bars, swapping the bass halfway', echo: 'Echo out on the next bar', filter: 'Filter sweep over 8 bars', cut: 'Cut on the next bar' }[kind]);
    refreshUI();
  }
  function runAuto() {
    if (!auto) return;
    const now = ctx.currentTime, { start, end, kind, from, to, target, origin } = auto;
    if (now < start) return;
    const p = kind === 'cut' ? 1 : Math.min(1, (now - start) / Math.max(0.01, end - start));
    if (kind === 'blend') {
      setXf(origin + (target - origin) * Math.min(1, p * 1.6));
      if (p >= 0.5 && to.kill.low) { to.kill.low = false; from.kill.low = true; to.applyEq(); from.applyEq(); refreshUI(); }
    } else if (kind === 'filter') { from.filt = p * 0.95; from.applyEq(); setKnob(`${from.side}:filter`, from.filt); setXf(origin + (target - origin) * p); }
    else if (kind === 'echo') { if (now >= start + (end - start) / 2) setXf(target); }
    else setXf(target);
    if (p >= 1) {
      from.pause(); from.kill = { low: false, mid: false, high: false }; from.filt = 0; from.applyEq();
      from.tFb.gain.cancelScheduledValues(now); from.tFb.gain.value = 0; from.tEcho.gain.cancelScheduledValues(now); from.tEcho.gain.value = 0;
      from.fader.gain.cancelScheduledValues(now); from.applyEq();
      to.syncLock = false;
      auto = null; refreshUI();
    }
  }

  // ---------------------------------------------------------------- sampler
  function playSample(i) {
    const s = SOUNDS[i];
    if (!sampleBufs[s.id]) { const x = synth(s.id, ctx.sampleRate); const b = ctx.createBuffer(1, x.length, ctx.sampleRate); b.copyToChannel(x, 0); sampleBufs[s.id] = b; }
    const src = ctx.createBufferSource(); src.buffer = sampleBufs[s.id]; src.connect(samplerGain); src.start();
  }

  // ---------------------------------------------------------------- pads, cue, loops
  const held = new Map(); // what a pressed pad/key is doing, so release can undo it
  function padDown(side, i, ev) {
    const d = decks[side]; if (!d.buffer) return;
    const key = `${side}${i}`;
    if (d.padMode === 'hot') {
      const h = d.hot[i];
      if (ev?.shiftKey || ev?.button === 2) { d.hot[i] = null; refreshUI(); return; }
      if (!h) { const at = d.q ? d.snap(d.time()) : d.time(); d.hot[i] = { t: at, label: '' }; refreshUI(); return; }
      if (d.playing) d.jumpTo(h.t);
      else { d.seek(h.t); d.play(); }
    } else if (d.padMode === 'roll') {
      const size = ROLLS[i], start = d.floorBeat(d.time(), size);
      d.roll = { start, end: start + size * d.beat, roll: true };
      d.post({ type: 'loop', loop: d.roll });
      held.set(key, { kind: 'roll', side });
    } else if (d.padMode === 'jump') {
      d.seek(d.time() + JUMPS[i] * d.beat);
    } else if (d.padMode === 'sampler') playSample(i);
    flashPad(side, i, true);
  }
  function padUp(side, i) {
    const key = `${side}${i}`, h = held.get(key), d = decks[side];
    flashPad(side, i, false);
    if (!h) return;
    held.delete(key);
    if (h.kind === 'roll') { d.roll = null; d.post({ type: 'loop', loop: d.loop }); }
  }
  let cuePreview = { A: false, B: false };
  function cueDown(side) {
    const d = decks[side]; if (!d.buffer) return;
    if (d.playing) { d.pause(); d.seek(d.cue); return; }
    const now = d.time();
    if (Math.abs(now - d.cue) < 0.03) { cuePreview[side] = true; d.play(); }
    else { d.cue = d.q ? d.snap(now) : now; d.seek(d.cue); }
  }
  function cueUp(side) {
    const d = decks[side];
    if (cuePreview[side]) { cuePreview[side] = false; d.pause(); d.seek(d.cue); }
  }
  function loopAction(side, a) {
    const d = decks[side]; if (!d.buffer) return;
    const now = d.time();
    if (a === 'loop') {
      if (d.loop) d.setLoop(null);
      else { const s = d.q ? d.floorBeat(now) : now; d.setLoop({ start: s, end: s + d.loopSize * d.beat }); }
    } else if (a === 'lhalf' || a === 'ldouble') {
      const i = LOOP_SIZES.indexOf(d.loopSize);
      d.loopSize = LOOP_SIZES[Math.max(0, Math.min(LOOP_SIZES.length - 1, i + (a === 'ldouble' ? 1 : -1)))];
      if (d.loop) d.setLoop({ start: d.loop.start, end: d.loop.start + d.loopSize * d.beat });
    } else if (a === 'lin') { d.loopIn = d.q ? d.snap(now) : now; if (d.loop) d.setLoop(null); }
    else if (a === 'lout') {
      if (d.loopIn == null || now <= d.loopIn + 0.05) return shell.toast('Press IN first, then OUT a moment later');
      let end = d.q ? d.snap(now) : now; if (end <= d.loopIn) end = d.loopIn + d.beat;
      d.setLoop({ start: d.loopIn, end }); d.loopIn = null;
    } else if (a === 'reloop') {
      if (d.loop) d.setLoop(null);
      else if (d.lastLoop) { d.setLoop(d.lastLoop); d.seek(d.lastLoop.start); }
    }
    refreshUI();
  }

  // ---------------------------------------------------------------- markup
  const btn = (a, label, title = '', cls = '') => `<button class="dk-btn ${cls}" data-a="${a}" title="${esc(title)}">${label}</button>`;
  function deckHTML(side) {
    const d = decks[side];
    if (!d.buffer) {
      return `<section class="dk empty" data-deck="${side}" style="--c:${COLORS[side]}"><span class="mx-badge">${side}</span>
        <button class="mx-pick" data-a="load"><b>+ Load a song on deck ${side}</b><span>From your library or SoundCloud</span></button></section>`;
    }
    return `<section class="dk" data-deck="${side}" style="--c:${COLORS[side]}">
      <header class="dk-head"><span class="mx-badge">${side}</span>${d.track.artwork ? `<img src="${esc(d.track.artwork)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'dk-noart'}))">` : '<span class="dk-noart"></span>'}
        <div class="dk-title"><b data-notr>${esc(d.track.title)}</b><span><i data-notr>${esc(d.track.artist)}</i> · <span data-notr>🔑 ${esc(d.an.key.name)} (${d.an.key.camelot})</span></span></div>
        <div class="dk-bpm"><b data-bpm data-notr>${d.bpm.toFixed(1)}</b><span>BPM</span></div>
        <button class="mini" data-a="load" title="Load another song">⏏</button></header>
      <div class="dk-over" data-over><canvas></canvas><i class="dk-ph"></i><span class="dk-time" data-time data-notr></span></div>
      <div class="dk-mid">
        <div class="dk-col">
          ${btn('sync', 'SYNC', 'Match the other deck’s tempo and line up the beats. Stays locked while lit.')}
          ${btn('q', 'Q', 'Quantize: cues, loops and jumps snap to the beat')}
          ${btn('slip', 'SLIP', 'Slip: after a scratch, reverse or roll, the song carries on where it would have been')}
          ${btn('vinyl', 'VINYL', 'Vinyl: touching the top of the platter scratches. Off: the platter only nudges the speed.')}
        </div>
        <div class="plat" data-plat="${side}" title="Drag the record to scratch · drag the outer ring or scroll to nudge">
          <div class="plat-disc">${d.track.artwork ? `<img src="${esc(d.track.artwork)}" alt="" onerror="this.remove()">` : ''}<i class="plat-dot"></i><i class="plat-mark"></i></div>
        </div>
        <div class="dk-pitch">
          ${btn('range', `±${d.range}%`, 'Pitch fader range', 'tiny')}
          <input type="range" class="vf pitch" data-pitch min="-1" max="1" step="0.001" value="${(d.rate - 1) * 100 / d.range}" title="Tempo (double-click to reset)">
          <b data-pct data-notr></b>
          <div class="dk-bend">${btn('bend-', '−', 'Hold to slow down a little (nudge)', 'tiny')}${btn('bend+', '+', 'Hold to speed up a little (nudge)', 'tiny')}</div>
        </div>
      </div>
      <div class="dk-trans">
        ${btn('cue', 'CUE', 'Stopped: set the cue point here (hold to preview). Playing: back to the cue point.', 'big cue')}
        ${btn('play', '<svg viewBox="0 0 24 24"><path d="M6 5v14l8-7zM15 5h3v14h-3z"/></svg>', 'Play / pause', 'big play')}
        ${btn('rev', 'REV', 'Play backwards')}
        ${btn('spin', 'SPIN', 'Spinback: whip the record backwards to a stop')}
        ${btn('brake', 'BRAKE', 'Vinyl start and stop: the record slows down and speeds up like a real turntable')}
      </div>
      <div class="dk-loop">
        ${btn('lhalf', '÷2', 'Halve the loop', 'tiny')}<span class="dk-lsize" data-lsize data-notr></span>${btn('ldouble', '×2', 'Double the loop', 'tiny')}
        ${btn('loop', 'LOOP', 'Loop the next beats (press again to leave)')}
        ${btn('lin', 'IN', 'Loop start')}${btn('lout', 'OUT', 'Loop end: starts looping')}${btn('reloop', 'RELOOP', 'Back into the last loop / leave the loop')}
      </div>
      <div class="dk-pads">
        <div class="seg small dk-pm">${[['hot', 'Hot cue'], ['roll', 'Roll'], ['jump', 'Jump'], ['sampler', 'Sampler']].map(([k, l]) => `<button data-pm="${k}">${l}</button>`).join('')}</div>
        <div class="pads">${Array.from({ length: 8 }, (_, i) => `<button class="pad" data-pad="${i}"><b></b><span></span></button>`).join('')}</div>
        <p class="dk-padhint" data-padhint></p>
      </div>
      <div class="dk-fx">
        <div class="seg small">${Object.entries(FX).map(([k, l]) => `<button data-fx="${k}">${l}</button>`).join('')}</div>
        <div class="seg small">${FX_BEATS.map((b) => `<button data-fxb="${b}" data-notr>${frac(b)}</button>`).join('')}</div>
        ${knobHTML(`${side}:fxamt`, 'Amount', { min: 0, max: 1, value: d.fx.amount, def: 0.5, small: true })}
        ${btn('fxon', 'FX ON', 'Turn the effect on or off')}
      </div>
    </section>`;
  }
  function chanHTML(side) {
    const d = decks[side];
    return `<div class="mx-ch" data-ch="${side}" style="--c:${COLORS[side]}">
      <span class="mx-chname">${side}</span>
      ${knobHTML(`${side}:trim`, 'Trim', { min: 0, max: 2, value: d.trimV, def: 1 })}
      ${['high', 'mid', 'low'].map((b) => `<div class="mx-eq">${knobHTML(`${side}:${b}`, b === 'high' ? 'Hi' : b === 'mid' ? 'Mid' : 'Low', { min: -26, max: 6, value: d.eq[b], def: 0 })}<button class="kill" data-kill="${b}" title="Cut the ${b}s">✕</button></div>`).join('')}
      ${knobHTML(`${side}:filter`, 'Filter', { min: -1, max: 1, value: d.filt, def: 0, bipolar: true })}
      <div class="mx-fad"><div class="vu" data-vu="${side}">${'<i></i>'.repeat(12)}</div><input type="range" class="vf" data-fader="${side}" min="0" max="1.2" step="0.01" value="${d.faderV}" title="Channel volume"></div>
    </div>`;
  }
  function render() {
    if (destroyed) return;
    el.innerHTML = `
      <div class="djx">
        <div class="dj-zoom"><canvas id="djZoom"></canvas></div>
        <div class="djc">
          ${deckHTML('A')}
          <section class="mx">
            <div class="mx-chs">${chanHTML('A')}<div class="mx-master">${knobHTML('master', 'Master', { min: 0, max: 1.5, value: djOut.gain.value, def: 1 })}<div class="vu big" data-vu="M">${'<i></i>'.repeat(14)}</div>${knobHTML('sampler', 'Sampler', { min: 0, max: 1.5, value: samplerGain.gain.value, def: 0.8, small: true })}</div>${chanHTML('B')}</div>
            <div class="mx-xf"><b>A</b><input type="range" id="djXf" min="-1" max="1" step="0.01" value="${xf}" title="Crossfader"><b>B</b></div>
            <div class="seg small mx-curve"><button data-curve="smooth">Smooth</button><button data-curve="cut">Sharp cut</button></div>
            <div class="mx-trans">
              <span class="dj-lbl">Auto transition</span>
              <button class="chip-btn" data-tr="blend" title="Crossfade over 8 bars and swap the bass halfway">🌗 Smooth blend</button>
              <button class="chip-btn" data-tr="filter" title="Thin out the old song while the new one comes in">🌀 Filter sweep</button>
              <button class="chip-btn" data-tr="echo" title="The old song echoes away">🔁 Echo out</button>
              <button class="chip-btn" data-tr="cut" title="Switch on the next bar">✂ Quick cut</button>
            </div>
            <button class="chip-btn ${recorder ? 'rec' : ''}" id="djRec">${recorder ? '■ Stop recording' : '● Record my mix'}</button>
          </section>
          ${deckHTML('B')}
        </div>
        <p class="cr-hint dj-keys">Keys: deck A pads 1–8, deck B pads Q–I · Z / M play · X / N cue · ← → crossfader · Shift-click or right-click a hot cue to clear it.</p>
      </div>`;
    wire();
    for (const kn of el.querySelectorAll('.kn')) paintKnob(kn, +kn.dataset.v);
    refreshUI();
    drawOverviews();
  }

  // ---------------------------------------------------------------- state → buttons
  function refreshUI() {
    if (destroyed) return;
    for (const side of ['A', 'B']) {
      const d = decks[side], root = el.querySelector(`[data-deck="${side}"]`);
      if (!root || !d.buffer) continue;
      const on = (a, v) => root.querySelector(`[data-a="${a}"]`)?.classList.toggle('on', !!v);
      on('sync', d.syncLock); on('q', d.q); on('slip', d.slip); on('vinyl', d.vinyl); on('brake', d.brake); on('rev', d.rev); on('loop', !!d.loop); on('fxon', d.fx.on);
      on('lin', d.loopIn != null); on('reloop', !!d.loop);
      root.querySelector('[data-a="range"]').textContent = `±${d.range}%`;
      root.querySelector('[data-lsize]').textContent = frac(d.loopSize);
      root.querySelectorAll('[data-pm]').forEach((b) => b.classList.toggle('on', b.dataset.pm === d.padMode));
      root.querySelectorAll('[data-fx]').forEach((b) => b.classList.toggle('on', b.dataset.fx === d.fx.type));
      root.querySelectorAll('[data-fxb]').forEach((b) => b.classList.toggle('on', +b.dataset.fxb === d.fx.beats));
      root.querySelector('[data-pitch]').value = (d.rate - 1) * 100 / d.range;
      root.querySelectorAll('.pad').forEach((p, i) => {
        let label = '', sub = '', color = '', set = true;
        if (d.padMode === 'hot') { const h = d.hot[i]; set = !!h; label = String(i + 1); sub = h ? (h.label || fmtTime(h.t)) : ''; color = h ? PAD_COLORS[i] : ''; }
        else if (d.padMode === 'roll') { label = frac(ROLLS[i]); sub = 'beat'; color = '#7b5cff'; }
        else if (d.padMode === 'jump') { label = `${JUMPS[i] > 0 ? '+' : ''}${JUMPS[i]}`; sub = 'beats'; color = JUMPS[i] < 0 ? '#39c6d6' : '#ffb36b'; }
        else { label = SOUNDS[i].icon; sub = SOUNDS[i].label; color = PAD_COLORS[(i + 3) % 8]; }
        p.querySelector('b').textContent = label; p.querySelector('span').textContent = sub;
        p.classList.toggle('unset', !set); p.style.setProperty('--pc', color || '#3a3330');
      });
      root.querySelector('[data-padhint]').textContent = {
        hot: 'Tap an empty pad to save a cue here, tap a lit pad to jump to it.',
        roll: 'Hold a pad to repeat that slice of the beat; let go and the song carries on.',
        jump: 'Jump backwards or forwards by whole beats, staying in time.',
        sampler: 'One-shot sounds on top of your mix.',
      }[d.padMode];
    }
    for (const side of ['A', 'B']) {
      const d = decks[side];
      for (const b of ['low', 'mid', 'high']) el.querySelector(`[data-ch="${side}"] [data-kill="${b}"]`)?.classList.toggle('on', d.kill[b]);
      setKnob(`${side}:filter`, d.filt);
    }
    el.querySelectorAll('[data-curve]').forEach((b) => b.classList.toggle('on', b.dataset.curve === xcurve));
  }
  function setKnob(id, v) { const k = el.querySelector(`[data-kn="${id}"]`); if (k && +k.dataset.v !== v) paintKnob(k, v); }
  function flashPad(side, i, down) { el.querySelector(`[data-deck="${side}"] [data-pad="${i}"]`)?.classList.toggle('down', down); }

  function knobChanged(id, v) {
    if (id === 'master') { djOut.gain.setTargetAtTime(v, ctx.currentTime, 0.02); return; }
    if (id === 'sampler') { samplerGain.gain.setTargetAtTime(v, ctx.currentTime, 0.02); return; }
    const [side, k] = id.split(':'), d = decks[side];
    if (k === 'trim') d.trimV = v;
    else if (k === 'filter') d.filt = Math.abs(v) < 0.04 ? 0 : v;
    else if (k === 'fxamt') { d.fx.amount = v; d.applyFx(); return; }
    else d.eq[k] = v;
    d.applyEq();
  }

  // ---------------------------------------------------------------- input wiring
  function wire() {
    el.querySelectorAll('[data-a="load"]').forEach((b) => b.onclick = async () => {
      const side = b.closest('[data-deck]').dataset.deck;
      const tr = await shell.pickTrack(`Load a song on deck ${side}`);
      if (tr) loadDeck(side, tr);
    });
    // knobs: drag vertically, scroll, double-click to reset
    el.querySelectorAll('.kn').forEach((k) => {
      const min = +k.dataset.min, max = +k.dataset.max;
      const set = (v) => { v = Math.max(min, Math.min(max, v)); paintKnob(k, v); knobChanged(k.dataset.kn, v); };
      k.onpointerdown = (e) => {
        e.preventDefault(); k.setPointerCapture(e.pointerId);
        const y0 = e.clientY, v0 = +k.dataset.v;
        k.onpointermove = (m) => set(v0 + ((y0 - m.clientY) / (m.shiftKey ? 600 : 160)) * (max - min));
        k.onpointerup = () => { k.onpointermove = null; };
      };
      k.onwheel = (e) => { e.preventDefault(); set(+k.dataset.v - Math.sign(e.deltaY) * (max - min) / 40); };
      k.ondblclick = () => set(+k.dataset.def);
    });
    el.querySelector('#djXf').oninput = (e) => { auto = null; setXf(+e.target.value); };
    el.querySelectorAll('[data-curve]').forEach((b) => b.onclick = () => { xcurve = b.dataset.curve; setXf(xf); refreshUI(); });
    el.querySelectorAll('[data-fader]').forEach((f) => f.oninput = () => { const d = decks[f.dataset.fader]; d.faderV = +f.value; d.applyEq(); });
    el.querySelectorAll('[data-fader]').forEach((f) => f.ondblclick = () => { f.value = 1; f.oninput(); });
    el.querySelectorAll('[data-ch]').forEach((ch) => ch.onclick = (e) => {
      const b = e.target.closest('[data-kill]'); if (!b) return;
      const d = decks[ch.dataset.ch]; d.kill[b.dataset.kill] = !d.kill[b.dataset.kill]; d.applyEq(); refreshUI();
    });
    el.querySelectorAll('[data-tr]').forEach((b) => b.onclick = () => transition(b.dataset.tr));
    el.querySelector('#djRec').onclick = toggleRecord;

    for (const side of ['A', 'B']) {
      const root = el.querySelector(`[data-deck="${side}"]`), d = decks[side];
      if (!root || !d.buffer) continue;
      root.addEventListener('contextmenu', (e) => { if (e.target.closest('.pad')) e.preventDefault(); });
      root.addEventListener('pointerdown', (e) => {
        const pad = e.target.closest('[data-pad]');
        if (pad) { e.preventDefault(); pad.setPointerCapture(e.pointerId); padDown(side, +pad.dataset.pad, e); return; }
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a;
        if (a === 'cue') { cueDown(side); b.classList.add('down'); }
        if (a === 'bend-' || a === 'bend+') { d.bend(a === 'bend+' ? 0.04 : -0.04); b.classList.add('down'); }
      });
      const release = (e) => {
        const pad = e.target.closest('[data-pad]');
        if (pad) { padUp(side, +pad.dataset.pad); return; }
        const b = e.target.closest('[data-a]'); if (!b) return;
        if (b.dataset.a === 'cue') { cueUp(side); b.classList.remove('down'); }
        if (b.dataset.a === 'bend-' || b.dataset.a === 'bend+') { d.bend(0); b.classList.remove('down'); }
      };
      root.addEventListener('pointerup', release);
      root.addEventListener('pointercancel', release);
      root.addEventListener('click', (e) => {
        const over = e.target.closest('[data-over]');
        if (over) { const r = over.getBoundingClientRect(); d.jumpTo(((e.clientX - r.left) / r.width) * d.dur); return; }
        const pm = e.target.closest('[data-pm]'); if (pm) { d.padMode = pm.dataset.pm; refreshUI(); return; }
        const fx = e.target.closest('[data-fx]'); if (fx) { d.fx.type = fx.dataset.fx; d.applyFx(); refreshUI(); return; }
        const fb = e.target.closest('[data-fxb]'); if (fb) { d.fx.beats = +fb.dataset.fxb; d.applyFx(); refreshUI(); return; }
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a;
        if (a === 'play') { audio(); if (d.playing) d.pause(); else d.play(); }
        else if (a === 'sync') { if (d.syncLock) d.syncLock = false; else if (sync(side)) d.syncLock = true; }
        else if (a === 'q') d.q = !d.q;
        else if (a === 'slip') { d.slip = !d.slip; d.post({ type: 'slip', on: d.slip }); }
        else if (a === 'vinyl') d.vinyl = !d.vinyl;
        else if (a === 'brake') d.brake = !d.brake;
        else if (a === 'rev') { d.rev = !d.rev; d.post({ type: 'rev', on: d.rev }); }
        else if (a === 'spin') { d.post({ type: 'spinback' }); d.st = { ...d.st, playing: false }; }
        else if (a === 'range') { const pct = (d.rate - 1) * 100; d.range = d.range === 8 ? 16 : d.range === 16 ? 50 : 8; if (Math.abs(pct) > d.range) d.setRate(1 + Math.sign(pct) * d.range / 100); }
        else if (a === 'fxon') { d.fx.on = !d.fx.on; d.applyFx(); }
        else if (['loop', 'lhalf', 'ldouble', 'lin', 'lout', 'reloop'].includes(a)) return loopAction(side, a);
        refreshUI();
      });
      const pitch = root.querySelector('[data-pitch]');
      pitch.oninput = () => { d.syncLock = false; d.setRate(1 + (+pitch.value * d.range) / 100); followLock(side); refreshUI(); };
      pitch.ondblclick = () => { pitch.value = 0; pitch.oninput(); };
      wirePlatter(side, root.querySelector('[data-plat]'));
    }
  }
  function followLock(changedSide) { // a deck locked with SYNC follows the other deck's tempo
    const o = decks[other(changedSide)];
    if (o.syncLock && o.an && decks[changedSide].an) sync(o.side, { phase: false });
  }

  // ---------------------------------------------------------------- the turntable: scratch & nudge
  const platState = { A: null, B: null };
  function wirePlatter(side, plat) {
    const d = decks[side];
    const angleOf = (e) => { const r = plat.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
    plat.onpointerdown = (e) => {
      e.preventDefault(); plat.setPointerCapture(e.pointerId); audio();
      const r = plat.getBoundingClientRect();
      const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / (r.width / 2);
      const scratch = d.vinyl && dist < 0.82;
      const st = { scratch, last: angleOf(e), lastT: performance.now(), hand: d.time() };
      platState[side] = st;
      if (scratch) { d.post({ type: 'touch', on: true, pos: st.hand }); plat.classList.add('touch'); }
      else plat.classList.add('nudge');
    };
    plat.onpointermove = (e) => {
      const st = platState[side]; if (!st) return;
      const a = angleOf(e); let da = a - st.last; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      st.last = a;
      const now = performance.now(), dt = Math.max(1, now - st.lastT) / 1000; st.lastT = now;
      if (st.scratch) { st.hand = Math.max(0, Math.min(d.dur, st.hand + (da / (2 * Math.PI)) * SEC_PER_REV)); d.post({ type: 'hand', pos: st.hand }); }
      else { const turnsPerSec = da / (2 * Math.PI) / dt; d.bend(Math.max(-0.3, Math.min(0.3, turnsPerSec * 0.12))); clearTimeout(st.decay); st.decay = setTimeout(() => d.bend(0), 90); }
    };
    const up = () => {
      const st = platState[side]; if (!st) return;
      platState[side] = null; plat.classList.remove('touch', 'nudge');
      if (st.scratch) d.post({ type: 'touch', on: false }); else d.bend(0);
    };
    plat.onpointerup = up; plat.onpointercancel = up;
    plat.onwheel = (e) => { e.preventDefault(); d.bend(Math.max(-0.2, Math.min(0.2, -e.deltaY * 0.0015))); clearTimeout(plat._w); plat._w = setTimeout(() => d.bend(0), 140); };
  }

  // ---------------------------------------------------------------- recording
  function toggleRecord() {
    if (recorder) { recorder.stop(); return; }
    chunks = [];
    recorder = new MediaRecorder(recDest.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' }), now = new Date(), stamp = new Date(now - now.getTimezoneOffset() * 60e3).toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `Mixtape DJ mix ${stamp}.webm`; a.click();
      const src = decks.A.track || decks.B.track;
      saveInspiration(blob, { kind: 'dj', title: `DJ mix ${stamp.replace(/-(\d\d)-(\d\d)$/, ' $1:$2')}`, track: src, durationSec: (Date.now() - recStart) / 1000 }, shell.toast);
      recorder = null; const b = el.querySelector('#djRec'); if (b) { b.classList.remove('rec'); b.textContent = t('● Record my mix'); }
    };
    recorder.start(1000); recStart = Date.now();
    const b = el.querySelector('#djRec'); b.classList.add('rec'); b.textContent = t('■ Stop recording');
  }

  // ---------------------------------------------------------------- keyboard
  const onKey = (e, down) => {
    if (e.target.closest('input:not([type=range]), textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    let i = KEYS_A.indexOf(k), side = 'A';
    if (i < 0) { i = KEYS_B.indexOf(k); side = 'B'; }
    if (i >= 0) { e.preventDefault(); if (down && !e.repeat) padDown(side, i, e); else if (!down) padUp(side, i); return; }
    if (e.repeat) return;
    if (k === 'z' || k === 'm') { if (down) { const d = decks[k === 'z' ? 'A' : 'B']; if (d.buffer) { d.playing ? d.pause() : d.play(); } } }
    else if (k === 'x' || k === 'n') { const s = k === 'x' ? 'A' : 'B'; down ? cueDown(s) : cueUp(s); }
    else if (down && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); auto = null; setXf(xf + (e.key === 'ArrowLeft' ? -0.1 : 0.1)); const x = el.querySelector('#djXf'); if (x) x.value = xf; }
  };
  const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
  document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);

  // ---------------------------------------------------------------- drawing
  function drawOverviews() {
    for (const side of ['A', 'B']) {
      const d = decks[side], cv = el.querySelector(`[data-deck="${side}"] [data-over] canvas`);
      if (!d.buffer || !cv) continue;
      const marks = d.hot.filter(Boolean).map((h) => h.t / d.dur);
      const lp = d.roll || d.loop;
      const regions = lp ? [{ x0: lp.start / d.dur, x1: lp.end / d.dur, color: hexA(COLORS[side], 0.22) }] : [];
      drawWave(cv, d.peaks, { color: COLORS[side], progress: d.time() / d.dur, marks, regions });
    }
  }
  function drawZoom() {
    const cv = el.querySelector('#djZoom'); if (!cv) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const half = 2.5; // seconds of real time either side of the playhead
    ['A', 'B'].forEach((side, lane) => {
      const d = decks[side], y0 = (lane * h) / 2, lh = h / 2, mid = y0 + lh / 2;
      g.fillStyle = lane ? '#141819' : '#19140f'; g.fillRect(0, y0, w, lh - 1);
      if (!d.buffer) { g.fillStyle = 'rgba(255,255,255,.25)'; g.font = '11px Inter, sans-serif'; g.fillText(`${side} —`, 10, mid + 4); return; }
      const now = d.time(), span = half * Math.max(0.5, d.rate);
      const t0 = now - span, toX = (tt) => ((tt - t0) / (2 * span)) * w;
      const lp = d.roll || d.loop;
      if (lp) { g.fillStyle = hexA(COLORS[side], 0.16); g.fillRect(toX(lp.start), y0, toX(lp.end) - toX(lp.start), lh); }
      // beat grid: bars brighter
      const b = d.beat; let k = Math.ceil((t0 - d.an.downbeat) / b);
      for (let tt = d.an.downbeat + k * b; tt < now + span; tt += b, k++) {
        g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.08)'; g.fillRect(Math.round(toX(tt)), y0, 1, lh);
      }
      const col = 120, sc = (lh / 2 - 3) / d.zmax;
      g.fillStyle = COLORS[side];
      for (let x = 0; x < w; x++) {
        const tt = t0 + (x / w) * 2 * span, c = Math.floor(tt * col);
        if (c < 0 || c * 2 + 1 >= d.zoom.length) continue;
        const lo = d.zoom[c * 2], hi = d.zoom[c * 2 + 1];
        g.globalAlpha = tt < now ? 0.55 : 1;
        g.fillRect(x, mid - hi * sc, 1, Math.max(1, (hi - lo) * sc));
      }
      g.globalAlpha = 1;
      d.hot.forEach((hc, i) => { if (!hc) return; const x = toX(hc.t); if (x < -10 || x > w + 10) return; g.fillStyle = PAD_COLORS[i]; g.beginPath(); g.moveTo(x, y0); g.lineTo(x + 7, y0); g.lineTo(x, y0 + 9); g.fill(); g.fillRect(x, y0, 1.5, lh); });
      const cx = toX(d.cue); g.fillStyle = '#ffd34d'; g.beginPath(); g.moveTo(cx - 5, y0 + lh); g.lineTo(cx + 5, y0 + lh); g.lineTo(cx, y0 + lh - 7); g.fill();
    });
    g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 6; g.fillRect(w / 2 - 1, 0, 2, h); g.shadowBlur = 0;
  }
  function paintVu(elv, peak) {
    if (!elv) return;
    const db = 20 * Math.log10(peak + 1e-6), segs = elv.children, n = segs.length;
    const lit = Math.round(Math.max(0, Math.min(1, (db + 36) / 36)) * n);
    for (let i = 0; i < n; i++) segs[i].className = i < lit ? (i >= n - 2 ? 'r' : i >= n - 4 ? 'y' : 'g') : '';
  }

  el.innerHTML = '<div class="cr-loading"><div class="spinner big"></div><h3>Setting up the decks…</h3></div>';
  for (const side of ['A', 'B']) decks[side].onEnded = () => { if (!destroyed) refreshUI(); };
  if (shell.track) await loadDeck('A', shell.track); else render();

  let lastOver = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    runAuto();
    for (const side of ['A', 'B']) {
      const d = decks[side], root = el.querySelector(`[data-deck="${side}"]`);
      if (!root || !d.buffer) continue;
      const tt = platState[side]?.scratch ? platState[side].hand : d.time();
      const disc = root.querySelector('.plat-disc');
      if (disc) disc.style.transform = `rotate(${((tt / SEC_PER_REV) * 360) % 360}deg)`;
      root.querySelector('[data-time]').textContent = `${fmtTime(tt)} · −${fmtTime(d.dur - tt)}`;
      root.querySelector('[data-bpm]').textContent = d.bpm.toFixed(1);
      const pct = (d.rate * (1 + d.bendV) - 1) * 100;
      root.querySelector('[data-pct]').textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      root.querySelector('.dk-ph').style.left = `${(tt / d.dur) * 100}%`;
      root.querySelector('[data-a="play"]').classList.toggle('on', d.playing);
      root.querySelector('[data-a="cue"]').classList.toggle('blink', !d.playing && Math.abs(tt - d.cue) > 0.03);
      const lit = d.padMode === 'hot' ? d.hot.findIndex((h) => h && Math.abs(h.t - tt) < 0.15) : -1;
      root.querySelectorAll('.pad').forEach((p, i) => p.classList.toggle('at', i === lit));
      paintVu(el.querySelector(`[data-vu="${side}"]`), d.level());
      root.style.setProperty('--lvl', Math.min(1, d.level() * 1.2));
    }
    master.analyser.getFloatTimeDomainData(meterBuf); let mp = 0; for (const v of meterBuf) mp = Math.max(mp, Math.abs(v));
    paintVu(el.querySelector('[data-vu="M"]'), mp);
    const x = el.querySelector('#djXf'); if (x && auto) x.value = xf;
    drawZoom();
    if (performance.now() - lastOver > 200) { lastOver = performance.now(); drawOverviews(); }
  };
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      destroyed = true; cancelAnimationFrame(raf);
      document.removeEventListener('keydown', kd); document.removeEventListener('keyup', ku);
      recorder?.stop();
      for (const d of Object.values(decks)) { d.post({ type: 'pause' }); try { d.fLfo.stop(); d.gLfo.stop(); } catch {} d.node.disconnect(); d.xf.disconnect(); }
      djOut.disconnect();
      master.analyser.disconnect(recDest);
    },
  };
}
