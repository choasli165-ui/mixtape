import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VocalTuner, Detector, scaleTarget, referenceTarget, Corrector, hzToMidi } from '../public/dsp/tune.js';
import { trackPitch } from '../public/dsp/melody.js';
import { effective, guessLanguage, PRESETS } from '../public/dsp/vocal-presets.js';

const sr = 48000;
function voice(hz, secs, { vib = 0, amp = 0.15 } = {}) {
  const n = Math.round(sr * secs), x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (hz * Math.pow(2, (vib * Math.sin((2 * Math.PI * 5.5 * i) / sr)) / 12)) / sr;
    let s = 0; for (let h = 1; h <= 16; h++) s += Math.sin(2 * Math.PI * h * ph) / h;
    x[i] = amp * s * Math.min(1, i / 480, (n - i) / 480);
  }
  return x;
}
function run(x, settings, { notes = [] } = {}) {
  const t = new VocalTuner(sr, settings); t.notes = notes; t.clock = { playing: true, songTime: 0, ctxTime: 0, rate: 1 };
  const y = new Float32Array(x.length);
  for (let o = 0; o < x.length; o += 128) { const ob = new Float32Array(128); t.process(x.subarray(o, o + 128), ob, o / sr); y.set(ob.subarray(0, Math.min(128, x.length - o)), o); }
  return { y, t };
}
const median = (a) => { a = a.filter(Number.isFinite).sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
const pitchOf = (y) => median(trackPitch(y.subarray(sr / 2), sr, { minHz: 60, maxHz: 1100 }).frames.map((f) => f.midi));

test('detector finds the pitch of a sung note', () => {
  const d = new Detector(sr), x = voice(196, 0.3);
  for (const s of x) d.push(s);
  const r = d.detect();
  assert.ok(Math.abs(hzToMidi(r.hz) - hzToMidi(196)) < 0.05, `got ${r.hz}`);
  assert.ok(r.clarity > 0.8);
});

test('targets: song key and the original melody (octave-folded)', () => {
  assert.equal(scaleTarget(61.4, 0, 'major'), 62);   // C♯ is not in C major → D
  assert.equal(scaleTarget(61.4, 0, 'chromatic'), 61);
  assert.equal(scaleTarget(63.4, 9, 'minor'), 64);   // A minor: E
  const notes = [{ start: 1, dur: 1, midi: 71 }, { start: 2.1, dur: 1, midi: 74 }];
  assert.equal(referenceTarget(58.6, notes, 1.5).midi, 59);   // an octave below the singer on the record
  assert.equal(referenceTarget(61.8, notes, 2.05).midi, 62); // just before the next note: timing slack
  assert.equal(referenceTarget(55, notes, 1.5), null);        // far away: let the key decide
});

test('correction pulls an out-of-tune voice onto the note, with strength', () => {
  const sharp = voice(220 * Math.pow(2, 0.4 / 12), 1.6); // A3 + 40 cents
  assert.ok(Math.abs(pitchOf(run(sharp, { mode: 'scale', tonic: 0, scale: 'major', strength: 1, speedMs: 0, vibrato: 0, toleranceCents: 0 }).y) - 57) < 0.05);
  assert.ok(Math.abs(pitchOf(run(sharp, { mode: 'scale', tonic: 0, scale: 'major', strength: 0.5, speedMs: 0, vibrato: 0, toleranceCents: 0 }).y) - 57.2) < 0.06);
  assert.ok(Math.abs(pitchOf(run(sharp, { mode: 'off' }).y) - 57.4) < 0.05);
  const ref = run(voice(440 * Math.pow(2, (58.3 - 69) / 12), 1.6), { mode: 'reference', strength: 1, speedMs: 0, vibrato: 0, toleranceCents: 0 }, { notes: [{ start: 0, dur: 5, midi: 47 }] });
  assert.ok(Math.abs(pitchOf(ref.y) - 59) < 0.05);
  assert.equal(ref.t.last.source, 'song');
});

test('hard tune flattens vibrato, natural keeps it', () => {
  const x = voice(220 * Math.pow(2, 0.3 / 12), 2, { vib: 0.5 });
  const wobble = (y) => { const f = trackPitch(y.subarray(sr), sr, { minHz: 60, maxHz: 1100 }).frames.map((q) => q.midi).filter(Number.isFinite); const m = f.reduce((a, b) => a + b, 0) / f.length; return Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / f.length); };
  assert.ok(wobble(run(x, { mode: 'scale', strength: 1, speedMs: 0, vibrato: 0, toleranceCents: 0 }).y) < 0.12);
  assert.ok(wobble(run(x, { mode: 'scale', strength: 1, speedMs: 40, vibrato: 1, toleranceCents: 0 }).y) > 0.25);
});

test('latency adapts to the singer during a pause and the output has no clicks', () => {
  const gap = new Float32Array(sr / 2);
  const x = new Float32Array(sr * 2.5); x.set(voice(233, 1)); x.set(gap, sr); x.set(voice(233, 1), sr * 1.5);
  const { y, t } = run(x, { mode: 'scale', strength: 1, speedMs: 20 });
  assert.ok(t.ps.D / sr < 0.012, `latency ${t.ps.D / sr}`);
  const jump = (a) => { let m = 0; for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };
  assert.ok(jump(y) <= jump(x) * 1.3);
});

test('real-time budget: well under the audio deadline', () => {
  const x = voice(150, 3), t0 = performance.now();
  run(x, { mode: 'scale', strength: 1, speedMs: 30 });
  assert.ok((performance.now() - t0) / 3000 < 0.25, 'uses less than a quarter of one core');
});

test('presets and language styles', () => {
  assert.equal(guessLanguage({ title: '夜に駆ける', artist: 'YOASOBI' }), 'ja');
  assert.equal(guessLanguage({ title: '晴天', artist: '周杰伦' }), 'zh');
  assert.equal(guessLanguage({ title: 'Someone Like You', artist: 'Adele' }), 'en');
  const hard = effective({ preset: 'hard', lang: 'en' });
  assert.equal(hard.speedMs, 0); assert.equal(hard.vibrato, 0);
  assert.ok(effective({ preset: 'pop', lang: 'en' }).speedMs > effective({ preset: 'pop', lang: 'ja' }).speedMs);
  assert.equal(effective({ preset: 'pop', lang: 'zh', overrides: { reverb: 0.9 } }).reverb, 0.9);
  for (const k of Object.keys(PRESETS)) assert.ok(effective({ preset: k, lang: 'zh' }).strength > 0);
});

test('a quiet microphone is levelled up without clipping', () => {
  const x = voice(220, 4, { amp: 0.004 }); // about −50 dBFS: a typical mic with Windows' auto-gain off
  const { y, t } = run(x, { mode: 'scale', strength: 1, speedMs: 40, inputProcessing: true });
  const tail = y.subarray(sr * 3);
  const rms = Math.sqrt(tail.reduce((a, v) => a + v * v, 0) / tail.length);
  assert.ok(20 * Math.log10(rms) > -24, `output ${20 * Math.log10(rms)} dBFS`);
  assert.ok(Math.max(...tail.map(Math.abs)) < 1, 'no clipping');
  assert.ok(t.agc > 10);
});

test('music leaking from speakers and room noise are not mistaken for singing', () => {
  // the "music": a melody at a different pitch, heard by the mic at −20 dB, plus fan noise
  const music = voice(330, 6, { amp: 0.2 });
  const mic = new Float32Array(music.length);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < mic.length; i++) mic[i] = music[i] * 0.1 + rnd() * 0.002;
  const singer = voice(196, 2, { amp: 0.06 }); // the singer comes in from 4 s, clearly louder than the bleed
  for (let i = 0; i < singer.length; i++) mic[sr * 4 + i] += singer[i];
  const t = new VocalTuner(sr, { mode: 'scale', strength: 1, inputProcessing: true }); t.clock = { playing: false };
  const frames = [];
  for (let o = 0; o < mic.length; o += 128) {
    let e = 0; for (let i = o; i < o + 128 && i < music.length; i++) e += music[i] * music[i];
    t.setMusicLevel(Math.sqrt(e / 128));
    frames.push(...t.process(mic.subarray(o, o + 128), new Float32Array(128), o / sr));
  }
  const before = frames.filter((f) => f.t > 1 && f.t < 3.9 && Number.isFinite(f.midi));
  const during = frames.filter((f) => f.t > 4.3 && f.t < 5.8 && Number.isFinite(f.midi));
  assert.ok(before.length < 5, `bleed detected as voice ${before.length} times`);
  assert.ok(during.length > 150, `voice detected only ${during.length} times`);
  assert.ok(Math.abs(median(during.map((f) => f.midi)) - hzToMidi(196)) < 0.2);
});

test('rumble, mains hum and thumps are removed, the voice is kept', () => {
  const n = sr * 6, x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = 0.02 * Math.sin(2 * Math.PI * 25 * t)                                         // rumble
      + 0.006 * (Math.sin(2 * Math.PI * 50 * t) + 0.6 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t)); // 50 Hz hum
    for (const at of [4.2, 5.1]) if (t > at && t < at + 0.08) x[i] += 0.3 * Math.sin(2 * Math.PI * 40 * (t - at)) * Math.exp(-(t - at) * 40); // thumps
  }
  const v = voice(110, 3, { amp: 0.02 }); // a low male voice from 3 s
  for (let i = 0; i < v.length; i++) x[sr * 3 + i] += v[i];
  const { y, t } = run(x, { mode: 'off', inputProcessing: true });
  assert.equal(t.humHz, 50, 'hum detected as 50 Hz');
  const band = (a, f, from, to) => { // level of frequency f in a stretch of audio
    const s = Math.round(from * sr), e = Math.round(to * sr), k = 2 * Math.cos((2 * Math.PI * f) / sr); let s1 = 0, s2 = 0;
    for (let i = s; i < e; i++) { const s0 = a[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / (e - s);
  };
  const db = (a, b) => 20 * Math.log10(a / b);
  // measured against the voice, so the automatic level doesn't matter
  const before = { rumble: db(band(x, 25, 3.2, 4), band(x, 110, 3.2, 4)), hum: db(band(x, 50, 3.2, 4), band(x, 110, 3.2, 4)) };
  const after = { rumble: db(band(y, 25, 3.2, 4), band(y, 110, 3.2, 4)), hum: db(band(y, 50, 3.2, 4), band(y, 110, 3.2, 4)) };
  assert.ok(before.rumble - after.rumble > 30, `rumble only ${before.rumble - after.rumble} dB lower`);
  assert.ok(before.hum - after.hum > 25, `hum only ${before.hum - after.hum} dB lower`);
  assert.ok(Math.abs(pitchOf(y.subarray(sr * 3)) - hzToMidi(110)) < 0.1, 'voice untouched');
});

test('plain microphone by default: no automatic gain, no gate, no filters', () => {
  const x = voice(110, 3, { amp: 0.004 }); // quiet mic stays quiet: nothing is added
  const { y, t } = run(x, { mode: 'off' });
  assert.equal(t.agc, 1);
  const d = 0; let maxDiff = 0;
  for (let i = 1000; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i] - x[i] + d));
  assert.ok(maxDiff < 1e-6, 'with correction off the voice passes through unchanged');
  const tuned = run(voice(220 * Math.pow(2, 0.4 / 12), 1.6, { amp: 0.004 }), { mode: 'scale', strength: 1, speedMs: 0, vibrato: 0, toleranceCents: 0 });
  assert.ok(Math.abs(pitchOf(tuned.y) - 57) < 0.06, 'pitch correction still works on a quiet, untouched mic');
});
