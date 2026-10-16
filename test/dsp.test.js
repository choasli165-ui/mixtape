import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft } from '../public/dsp/fft.js';
import { stretchPitch, pitchShift } from '../public/dsp/pv.js';
import { detectTempo, detectKey, analyze, compatibility, keyShift, describeKey } from '../public/dsp/analyze.js';
import { extractNotes } from '../public/dsp/melody.js';
import { renderNotes, INSTRUMENTS } from '../public/dsp/synth.js';

const SR = 44100;
const sine = (f, sec, a = 0.5) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
// Repeatable noise, matching the Park–Miller generator used by tune.test.js.
const seededRandom = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Dominant frequency via FFT of the middle of the signal. */
function domFreq(x) {
  const n = 16384, re = new Float64Array(n), im = new Float64Array(n);
  const o = Math.floor((x.length - n) / 2);
  for (let i = 0; i < n; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  let best = 0, k = 0;
  for (let i = 1; i < n / 2; i++) { const m = Math.hypot(re[i], im[i]); if (m > best) { best = m; k = i; } }
  return (k * SR) / n;
}

test('fft round trip', () => {
  const re = Float64Array.from({ length: 1024 }, seededRandom()), im = new Float64Array(1024);
  const orig = Float64Array.from(re);
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 1024; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('pitch shift keeps length and moves pitch by the right interval', () => {
  const x = sine(440, 3);
  for (const [semi, want] of [[12, 880], [-12, 220], [3, 440 * 2 ** 0.25], [-5, 440 * 2 ** (-5 / 12)]]) {
    const y = pitchShift(x, semi);
    assert.equal(y.length, x.length);
    const f = domFreq(y);
    assert.ok(Math.abs(f - want) / want < 0.02, `${semi} st: ${f} vs ${want}`);
    // energy preserved roughly (no silence / blow-up)
    const rms = Math.sqrt(y.slice(SR, 2 * SR).reduce((s, v) => s + v * v, 0) / SR);
    assert.ok(rms > 0.25 && rms < 0.5, `rms ${rms}`);
  }
});

test('tempo change keeps pitch', () => {
  const x = sine(330, 4);
  const y = stretchPitch(x, { tempoRatio: 1.25 });
  assert.equal(y.length, Math.round(x.length / 1.25));
  assert.ok(Math.abs(domFreq(y) - 330) < 330 * 0.02);
});

function clickTrack(bpm, sec, extra = () => 0) {
  const x = new Float32Array(Math.round(sec * SR));
  const period = (60 / bpm) * SR;
  for (let b = 0, t = 0.5 * SR; t < x.length; b++, t += period) {
    const amp = b % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < 2000 && t + i < x.length; i++) x[Math.round(t) + i] += amp * Math.sin((2 * Math.PI * (b % 4 === 0 ? 60 : 200) * i) / SR) * Math.exp(-i / 400);
  }
  for (let i = 0; i < x.length; i++) x[i] += extra(i);
  return x;
}

test('tempo detection on click tracks (incl. phonk tempos)', () => {
  for (const bpm of [90, 120, 140, 160]) {
    const r = detectTempo(clickTrack(bpm, 20), SR);
    const ok = [bpm, bpm * 2, bpm / 2].some((b) => Math.abs(r.bpm - b) / b < 0.02);
    assert.ok(ok, `${bpm} → ${r.bpm}`);
    const period = 60 / r.bpm, ph = ((((r.firstBeat - 0.5) / period) % 1) + 1) % 1;
    assert.ok(Math.min(ph, 1 - ph) * period < 0.04, `phase ${r.firstBeat} (bpm ${r.bpm})`);
  }
});

test('key detection on a chord progression', () => {
  // A minor: Am – F – C – G  (pitch classes)
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const parts = [];
  for (let rep = 0; rep < 3; rep++) for (const c of chords) {
    const seg = new Float32Array(SR);
    for (const m of [...c, c[0] - 12]) { const f = 440 * 2 ** ((m - 69) / 12); for (let i = 0; i < SR; i++) seg[i] += 0.15 * Math.sin((2 * Math.PI * f * i) / SR); }
    parts.push(seg);
  }
  const x = new Float32Array(parts.length * SR); parts.forEach((p, i) => x.set(p, i * SR));
  const k = detectKey(x, SR);
  assert.ok(['A minor', 'C major'].includes(k.name), k.name); // relative keys share notes
  assert.match(k.camelot, /^8[AB]$/);
});

test('key helpers + compatibility', () => {
  const am = describeKey(9, 'minor'), c = describeKey(0, 'major'), d = describeKey(2, 'major');
  assert.equal(am.camelot, '8A'); assert.equal(c.camelot, '8B');
  assert.equal(keyShift(am, c), 0);
  assert.equal(keyShift(c, d), -2);
  const good = compatibility({ bpm: 140, key: am }, { bpm: 70, key: c });
  assert.equal(good.label, 'Great match');
  const bold = compatibility({ bpm: 140, key: c }, { bpm: 97, key: describeKey(6, 'major') });
  assert.notEqual(bold.label, 'Great match');
});

test('analysis finds sections from loudness changes', () => {
  const quiet = clickTrack(120, 16).map((v) => v * 0.15);
  const loud = clickTrack(120, 16, (i) => 0.3 * Math.sin((2 * Math.PI * 110 * i) / SR));
  const x = new Float32Array(quiet.length * 3);
  x.set(quiet, 0); x.set(loud, quiet.length); x.set(quiet, quiet.length * 2);
  const a = analyze(x, SR);
  assert.ok(Math.abs(a.bpm - 120) < 3 || Math.abs(a.bpm - 60) < 2, String(a.bpm));
  assert.ok(a.sections.length >= 2, JSON.stringify(a.sections));
  assert.ok(a.sections.some((s) => s.label === 'Drop'), JSON.stringify(a.sections.map((s) => s.label)));
});

test('melody extraction: notes of a simple tune', () => {
  const tune = [60, 64, 67, 72, 67, 64];
  const parts = tune.map((m) => sine(440 * 2 ** ((m - 69) / 12), 0.3, 0.4));
  const gap = new Float32Array(Math.round(0.05 * SR));
  const x = new Float32Array(parts.reduce((s, p) => s + p.length + gap.length, 0));
  let o = 0; for (const p of parts) { x.set(p, o); o += p.length + gap.length; }
  const notes = extractNotes(x, SR, { lane: 'other' });
  assert.deepEqual(notes.map((n) => n.midi), tune, JSON.stringify(notes));
  assert.ok(Math.abs(notes[1].start - 0.35) < 0.05);
  const bassNotes = extractNotes(sine(55, 1, 0.5), SR, { lane: 'bass' });
  assert.equal(bassNotes[0]?.midi, 33);
});

test('every instrument renders audible, unclipped audio at the right pitch', (t) => {
  // Random pluck excitation can make a high harmonic dominate the pitch probe.
  // Fix the excitation and oscillator phases; the test context restores Math.random.
  t.mock.method(Math, 'random', seededRandom());
  for (const name of Object.keys(INSTRUMENTS)) {
    const [L, R] = renderNotes([{ start: 0.1, dur: 0.8, midi: 57, vel: 0.9 }], name, SR, SR * 2);
    const peak = Math.max(...L.map(Math.abs));
    assert.ok(peak > 0.05 && peak <= 0.91, `${name} peak ${peak}`);
    assert.equal(R.length, SR * 2);
    if (name === 'guitar') { // plucked strings are harmonic-rich: dominant must be a harmonic of 220 Hz
      const f = domFreq(L.subarray(0.15 * SR, 0.15 * SR + 20000)), h = f / 220;
      assert.ok(Math.abs(h - Math.round(h)) < 0.04, `guitar ${f}`);
    } else if (!['bells', 'marimba', 'cowbell', 'bass808'].includes(name)) {
      const f = domFreq(L.subarray(0.15 * SR, 0.15 * SR + 20000));
      assert.ok([220, 440, 660].some((t) => Math.abs(f - t) < 8), `${name} ${f}`);
    }
  }
});
