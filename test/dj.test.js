import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal AudioWorklet environment so the turntable engine can run in Node.
let Deck;
globalThis.sampleRate = 44100; globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { Deck = cls; };
await import('../public/dsp/dj-worklet.js');
const { SOUNDS, synth } = await import('../public/dsp/dj-sounds.js');

function deck(secs = 20) {
  const d = new Deck();
  const n = secs * 44100, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.sin(i / 20); R[i] = L[i]; }
  d.msg({ type: 'load', L, R, sr: 44100, at: 0 });
  return d;
}
function run(d, secs) {
  const out = [[new Float32Array(128), new Float32Array(128)]];
  for (let k = 0; k < Math.round((secs * 44100) / 128); k++) { d.process([], out); globalThis.currentTime += 128 / 44100; }
  return out[0][0];
}

test('plays at the pitch-fader speed', () => {
  const d = deck(); d.msg({ type: 'play' }); run(d, 1);
  assert.ok(Math.abs(d.pos - 1) < 0.01, `pos ${d.pos}`);
  d.msg({ type: 'rate', r: 1.08 }); run(d, 1);
  assert.ok(Math.abs(d.pos - 2.08) < 0.02, `pos ${d.pos}`);
});

test('scratching: the record follows the hand, back and forth, and stops under it', () => {
  const d = deck(); d.msg({ type: 'play' }); run(d, 2);
  d.msg({ type: 'touch', on: true, pos: d.pos });
  d.msg({ type: 'hand', pos: 1.5 }); run(d, 0.2);
  assert.ok(Math.abs(d.pos - 1.5) < 0.01, `backwards to ${d.pos}`);
  d.msg({ type: 'hand', pos: 1.8 }); run(d, 0.2);
  assert.ok(Math.abs(d.pos - 1.8) < 0.01);
  const held = d.pos; const y = run(d, 0.3);
  assert.ok(Math.abs(d.pos - held) < 0.005, 'held still');
  assert.ok(Math.max(...y.map(Math.abs)) < 0.05, 'a held record is silent');
  d.msg({ type: 'touch', on: false }); run(d, 0.5);
  assert.ok(d.vel > 0.95, 'motor brings it back up to speed');
});

test('loops wrap, and a loop roll with slip returns to where the song would be', () => {
  const d = deck(); d.msg({ type: 'play' }); run(d, 1);
  d.msg({ type: 'loop', loop: { start: 1, end: 1.25, roll: true } }); run(d, 1);
  assert.ok(d.pos >= 1 && d.pos <= 1.25, `in loop ${d.pos}`);
  d.msg({ type: 'loop', loop: null }); run(d, 0.01);
  assert.ok(Math.abs(d.pos - 2.01) < 0.03, `slipped back to ${d.pos}`);
});

test('reverse, spinback and vinyl brake', () => {
  const d = deck(); d.msg({ type: 'play' }); run(d, 3);
  d.msg({ type: 'rev', on: true }); run(d, 1);
  assert.ok(d.pos < 2.1 && d.pos > 1.9, `reversed to ${d.pos}`);
  d.msg({ type: 'rev', on: false }); d.msg({ type: 'spinback' }); run(d, 1.5);
  assert.equal(d.playing, false); assert.equal(d.vel, 0);
  d.msg({ type: 'play' }); run(d, 0.5);
  d.msg({ type: 'pause', brake: 0.8 }); run(d, 0.2);
  assert.ok(d.vel > 0.5, 'still slowing down');
  run(d, 4); assert.ok(Math.abs(d.vel) < 0.01);
});

test('sampler sounds are generated and normalised', () => {
  for (const s of SOUNDS) { const x = synth(s.id, 44100); assert.ok(x.length > 1000); assert.ok(Math.abs(Math.max(...x.map(Math.abs)) - 0.7) < 0.01); }
});
