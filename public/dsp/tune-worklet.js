// Audio-thread processors for Sing Mode: the live vocal tuner and a sample-accurate take recorder.
import { VocalTuner } from './tune.js';

class VocalTunerProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.t = new VocalTuner(sampleRate, opts.processorOptions || {});
    this.frames = []; this.lastPost = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'settings') this.t.set(m.settings);
      else if (m.type === 'notes') this.t.notes = m.notes || [];
      else if (m.type === 'clock') this.t.clock = m.clock;
      else if (m.type === 'music') this.t.setMusicLevel(m.rms);
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0]?.[0], out = outputs[0][0];
    if (!inp) { out.fill(0); return true; }
    const fr = this.t.process(inp, out, currentTime);
    for (const f of fr) this.frames.push(f);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (currentTime - this.lastPost > 0.03) {
      this.lastPost = currentTime;
      this.port.postMessage({ type: 'frames', frames: this.frames, latency: this.t.ps.D / sampleRate, gate: this.t.gateOpen, level: this.t.env, vad: this.t.vad, agc: this.t.agc, bleed: this.t.bleed > this.t.floor * 2, lowCut: this.t.cutHz, hum: this.t.humHz });
      this.frames = [];
    }
    return true;
  }
}
registerProcessor('vocal-tuner', VocalTunerProcessor);

class TakeRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.buf = null;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') { this.on = true; this.start = -1; this.chunks = [[], []]; this.len = 0; }
      if (e.data.cmd === 'stop' && this.on) { this.on = false; this.flush(true); }
    };
  }
  flush(done) {
    if (this.len) {
      const data = this.chunks.map((c) => { const a = new Float32Array(this.len); let o = 0; for (const b of c) { a.set(b, o); o += b.length; } return a; });
      this.port.postMessage({ type: 'chunk', start: this.start, data }, data.map((a) => a.buffer));
      this.start += this.len;
    }
    this.chunks = [[], []]; this.len = 0;
    if (done) this.port.postMessage({ type: 'stopped' });
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    if (this.on && inp?.length) {
      if (this.start < 0) this.start = currentFrame;
      for (let c = 0; c < 2; c++) this.chunks[c].push(inp[Math.min(c, inp.length - 1)].slice());
      this.len += inp[0].length;
      if (this.len >= 16384) this.flush(false);
    }
    for (const o of outputs[0] || []) o.fill(0);
    return true;
  }
}
registerProcessor('take-recorder', TakeRecorder);
