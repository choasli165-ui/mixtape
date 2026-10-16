// Real-time pitch shifter (two crossfaded delay-line grains). Instant preview while the HQ version renders.
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.G = Math.round(sampleRate * 0.045); // grain length
    this.size = this.G * 2 + 128;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0; this.phase = 0;
  }
  read(ch, d) {
    let p = this.w - d; while (p < 0) p += this.size;
    const i = Math.floor(p), f = p - i, b = this.buf[ch];
    return b[i % this.size] * (1 - f) + b[(i + 1) % this.size] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const semi = params.semitones[0];
    if (!inp.length) return true;
    if (Math.abs(semi) < 0.01) { for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)]); return true; }
    const r = Math.pow(2, semi / 12), G = this.G, step = (1 - r) / G;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) this.buf[c][this.w] = inp[Math.min(c, inp.length - 1)][i];
      this.phase += step; this.phase -= Math.floor(this.phase);
      const p2 = (this.phase + 0.5) % 1;
      const g1 = 1 - Math.abs(2 * this.phase - 1), g2 = 1 - Math.abs(2 * p2 - 1);
      for (let c = 0; c < out.length; c++) out[c][i] = this.read(Math.min(c, 1), this.phase * G + 1) * g1 + this.read(Math.min(c, 1), p2 * G + 1) * g2;
      this.w = (this.w + 1) % this.size;
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifter);
