// A virtual turntable on the audio thread. The record has a position and a velocity:
// the motor pulls the velocity towards the pitch-fader speed (fast like a CDJ, or slowly like vinyl),
// a hand on the platter pulls the position towards where the hand is (scratching), and loops,
// reverse, spinbacks and slip mode all work on that one moving read head.
class DJDeck extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.bsr = 44100; this.dur = 0;
    this.pos = 0; this.vel = 0; this.playing = false; this.rate = 1; this.bend = 0; this.rev = false;
    this.touch = false; this.hand = 0;
    this.loop = null; this.slip = false; this.shadow = 0; this.wasSlipping = false;
    this.startTau = 0.004; this.stopTau = 0.004;
    this.pending = null; this.spin = 0;
    this.xf = 0; this.oldPos = 0; this.g = 0;
    this.lastPost = 0; this.ended = false;
    this.port.onmessage = (e) => this.msg(e.data);
  }
  msg(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L; this.R = m.R; this.bsr = m.sr; this.dur = m.L.length / m.sr;
        this.pos = m.at || 0; this.vel = 0; this.playing = false; this.loop = null; this.spin = 0; this.ended = false; break;
      case 'play':
        this.startTau = m.startup || 0.004; this.spin = 0; this.ended = false;
        if (m.at != null) this.jump(m.at);
        if (m.when && m.when > currentTime) this.pending = { when: m.when }; else this.playing = true;
        break;
      case 'pause': this.stopTau = m.brake || 0.004; this.playing = false; this.pending = null; break;
      case 'seek': this.jump(m.t); this.shadow = this.pos; break;
      case 'rate': this.rate = m.r; break;
      case 'bend': this.bend = m.v; break;
      case 'touch': this.touch = m.on; if (m.on) this.hand = m.pos ?? this.pos; break;
      case 'hand': this.hand = m.pos; break;
      case 'rev': this.rev = m.on; break;
      case 'loop': this.loop = m.loop; break; // { start, end, roll }
      case 'slip': this.slip = m.on; this.shadow = this.pos; break;
      case 'spinback': this.spin = -(m.speed || 7); this.playing = false; this.stopTau = 0.5; break;
    }
  }
  jump(t) { this.oldPos = this.pos; this.xf = 1; this.pos = Math.max(0, Math.min(t, this.dur)); }
  read(a, p) { // 4-point Hermite interpolation
    const x = p * this.bsr, i = Math.floor(x), f = x - i, n = a.length;
    if (i < 1 || i + 2 >= n) return i >= 0 && i < n ? a[i] : 0;
    const y0 = a[i - 1], y1 = a[i], y2 = a[i + 1], y3 = a[i + 2];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
  process(inputs, outputs) {
    const out = outputs[0], OL = out[0], OR = out[1] || out[0], n = OL.length;
    if (!this.L) { OL.fill(0); OR.fill(0); return true; }
    const dt = 1 / sampleRate;
    if (this.pending && currentTime + n * dt >= this.pending.when) { this.playing = true; this.pending = null; }
    const kStart = 1 - Math.exp(-dt / this.startTau), kStop = 1 - Math.exp(-dt / this.stopTau);
    const kHand = 1 - Math.exp(-dt / 0.006), kG = 1 - Math.exp(-dt / 0.004);
    // slip: while scratching / reversing / rolling, a shadow keeps playing; letting go returns to it
    const slipping = !!this.loop?.roll || (this.slip && (this.touch || this.rev));
    if (this.wasSlipping && !slipping) this.jump(this.shadow);
    if (!slipping) this.shadow = this.pos;
    this.wasSlipping = slipping;
    const motor = this.rate * (1 + this.bend) * (this.rev ? -1 : 1);
    for (let i = 0; i < n; i++) {
      if (this.touch) {
        const vd = Math.max(-14, Math.min(14, (this.hand - this.pos) / 0.012));
        this.vel += (vd - this.vel) * kHand;
      } else if (this.spin) {
        this.vel = this.spin; this.spin *= 1 - dt / 0.28;
        if (Math.abs(this.spin) < 0.05) { this.spin = 0; this.vel = 0; this.stopTau = 0.004; }
      } else {
        this.vel += ((this.playing ? motor : 0) - this.vel) * (this.playing ? kStart : kStop);
      }
      if (slipping && this.playing) this.shadow += this.rate * (1 + this.bend) * dt;
      this.pos += this.vel * dt;
      const lp = this.loop;
      if (lp && lp.end > lp.start) {
        const len = lp.end - lp.start;
        if (this.vel > 0 && this.pos >= lp.end) this.pos -= len;
        else if (this.vel < 0 && this.pos < lp.start && this.pos > lp.start - 0.5) this.pos += len;
      }
      if (this.pos < 0) { this.pos = 0; if (this.vel < 0) this.vel = 0; }
      if (this.pos >= this.dur) { if (this.playing || this.vel > 0) this.ended = true; this.pos = this.dur; this.playing = false; this.vel = 0; }
      // level follows the platter speed: a stopped record is silent, a slow drag is quiet (no DC clicks)
      this.g += (Math.min(1, Math.abs(this.vel) * 6) - this.g) * kG;
      let l = this.read(this.L, this.pos), r = this.read(this.R, this.pos);
      if (this.xf > 0) {
        this.oldPos += this.vel * dt;
        const a = this.xf;
        l = l * (1 - a) + this.read(this.L, this.oldPos) * a; r = r * (1 - a) + this.read(this.R, this.oldPos) * a;
        this.xf = Math.max(0, this.xf - 1 / 240);
      }
      OL[i] = l * this.g; OR[i] = r * this.g;
    }
    if (currentTime - this.lastPost > 0.015 || this.ended) {
      this.lastPost = currentTime;
      this.port.postMessage({ type: 'pos', pos: this.pos, vel: this.vel, playing: this.playing || !!this.pending, t: currentTime + n * dt, ended: this.ended });
      this.ended = false;
    }
    return true;
  }
}
registerProcessor('dj-deck', DJDeck);
