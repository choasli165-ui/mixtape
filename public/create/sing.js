// Sing Mode: karaoke backing from the split song, live pitch correction of the microphone, a scrolling
// pitch guide with the original singer's melody, scoring, recording, listen-back and export.
import { SR, showDevice, loadMix, loadStems, analyzeTrack, work, mono, MultiPlayer, encodeWav, download, saveInspiration, fmtTime } from './core.js';
import { noteName, NOTE_NAMES } from '/dsp/tune.js';
import { PRESETS, LANGS, effective, guessLanguage } from '/dsp/vocal-presets.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE = 'mixtape.sing';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch {} };

// ------------------------------------------------------------------ helpers
function makeIR(c, type) {
  const [secs, pow, bright] = type === 'room' ? [0.8, 4, 0.6] : type === 'hall' ? [2.8, 3, 0.35] : [1.6, 3.5, 0.8];
  const len = Math.round(secs * c.sampleRate), b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) {
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * (bright + (1 - bright) * (1 - i / len) * 0.5); // darker tail
      d[i] = lp * Math.pow(1 - i / len, pow) * (i < c.sampleRate * 0.008 ? i / (c.sampleRate * 0.008) : 1);
    }
  }
  return b;
}
const isBluetooth = (label = '') => /bluetooth|airpods|buds|hands-?free|headset \(|wh-1000|bose|beats|jabra|freebuds/i.test(label);

const melodyCache = new Map();

// ------------------------------------------------------------------ view
export async function createSing(el, shell) {
  const track = shell.track;
  let destroyed = false;
  const S = load();
  S.preset ??= 'pop'; S.lang ??= 'auto'; S.overrides ??= {}; S.monitor ??= true;
  S.voiceVol ??= 1.2; S.guideVol ??= 0.12; S.bandVol ??= 0.7; S.mode ??= 'reference';
  S.setup ??= 'headphones'; S.duck ??= true; S.autoLevel ??= true; S.boost ??= 0;
  S.lowCut ??= 'auto'; S.hum ??= 'auto'; S.deboom ??= true;
  // plain, standard microphone handling for now: no extra processing on the input
  S.setup = 'headphones'; S.duck = false; S.autoLevel = false;
  if ((S.v || 0) < 2) { S.v = 2; S.voiceVol = 1.2; S.bandVol = Math.min(S.bandVol, 0.7); S.guideVol = Math.min(S.guideVol, 0.12); } // louder voice, softer music
  const persist = () => save(S);
  const lang = () => (S.lang === 'auto' ? guessLanguage(track) : S.lang);
  const P = () => ({ ...effective({ preset: S.preset, lang: lang(), overrides: S.overrides }), mode: S.mode });

  // ---------------------------------------------------------------- prepare the song
  el.innerHTML = `<div class="cr-loading"><div class="spinner big"></div><h3>Getting the song ready to sing…</h3><p id="sgLoadText">Downloading the song…</p><div class="cr-bar"><i id="sgLoadBar"></i></div><p class="cr-hint" id="sgLoadHint"></p></div>`;
  const setLoad = (p) => {
    if (destroyed) return;
    el.querySelector('#sgLoadText').textContent = p.text || '';
    el.querySelector('#sgLoadBar').style.width = `${p.pct ?? (p.stage === 'download' ? 8 : p.stage === 'load' ? 92 : 50)}%`;
    showDevice(el, p);
    el.querySelector('#sgLoadHint').textContent = p.stage === 'split' ? 'Separating the singer from the music, on your PC. This only happens once per song.' : '';
  };
  const [mix, stems] = await Promise.all([loadMix(track), loadStems(track, setLoad)]);
  if (destroyed) return { destroy() {} };
  setLoad({ stage: 'load', text: 'Learning the melody and key…' });
  const A = await analyzeTrack(track, mix, stems);
  let notes = melodyCache.get(track.id);
  if (!notes) {
    const v = mono(stems.vocals);
    notes = (await work('notes', { mono: v, sr: SR, lane: 'vocals' }, { transfer: [v.buffer] }))
      .filter((n) => n.dur >= 0.08 && n.vel > 0.06);
    melodyCache.set(track.id, notes);
  }
  if (destroyed) return { destroy() {} };
  const hasMelody = notes.length >= 8;
  if (!hasMelody && S.mode === 'reference') S.mode = 'scale';
  const key = { tonic: S.keyFor === track.id ? S.tonic : A.key.tonic, scale: S.keyFor === track.id ? S.scale : A.key.mode };

  // ---------------------------------------------------------------- audio graph
  const c = new AudioContext({ latencyHint: 0 });
  await c.audioWorklet.addModule('/dsp/tune-worklet.js');
  const master = c.createGain();
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -2; limiter.knee.value = 3; limiter.ratio.value = 14; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  master.connect(limiter).connect(c.destination);
  const sink = c.createGain(); sink.gain.value = 0; sink.connect(c.destination);

  // backing: band (everything but the singer) + guide (the original singer, quiet)
  const band = c.createGain(), guide = c.createGain(), takeGain = c.createGain();
  band.connect(master); guide.connect(master); takeGain.connect(master);
  const musicMeter = c.createAnalyser(); musicMeter.fftSize = 2048; band.connect(musicMeter); guide.connect(musicMeter);
  const musicBuf = new Float32Array(2048);
  const mp = new MultiPlayer(c);
  mp.duration = mix.duration;
  mp.setParts('band', band, ['drums', 'bass', 'guitar', 'piano', 'other'].map((k) => ({ buffer: stems[k], at: 0 })));
  mp.setParts('guide', guide, [{ buffer: stems.vocals, at: 0 }]);
  mp.setParts('take', takeGain, []);

  // voice chain
  const hp = c.createGain(); // microphone input point (no filtering)
  const tuner = new AudioWorkletNode(c, 'vocal-tuner', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { ...P(), tonic: key.tonic, scale: key.scale } });
  const low = c.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220;
  const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9;
  const air = c.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000;
  const comp = c.createDynamicsCompressor(); comp.knee.value = 8; comp.attack.value = 0.005; comp.release.value = 0.14;
  const makeup = c.createGain();
  const bus = c.createGain();
  hp.connect(tuner).connect(low).connect(pres).connect(air).connect(comp).connect(makeup).connect(bus);
  const fxHp = (hz) => { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = 0.7; return f; };
  const voiceOut = c.createGain(); // everything the listener hears of the voice
  const dry = c.createGain(); bus.connect(dry).connect(voiceOut);
  // doubler: two slightly-moving short delays, panned left and right
  const dbl = c.createGain(); dbl.connect(voiceOut);
  const dblParts = [[0.013, 0.31, -0.7], [0.021, 0.47, 0.7]].map(([t, rate, pan]) => {
    const d = c.createDelay(0.05); d.delayTime.value = t;
    const lfo = c.createOscillator(); lfo.frequency.value = rate; const depth = c.createGain(); depth.gain.value = 0.0018;
    lfo.connect(depth).connect(d.delayTime); lfo.start();
    const p = c.createStereoPanner(); p.pan.value = pan;
    bus.connect(fxHp(150)).connect(d).connect(p).connect(dbl);
    return { lfo };
  });
  const verbSend = c.createGain(), verb = c.createConvolver(), verbRet = c.createGain();
  bus.connect(verbSend).connect(fxHp(250)).connect(fxHp(250)).connect(verb).connect(verbRet).connect(voiceOut); // no muddy, boomy reverb
  const echoSend = c.createGain(), echo = c.createDelay(2), echoFb = c.createGain(), echoLp = c.createBiquadFilter(), echoRet = c.createGain();
  echoLp.type = 'lowpass'; echoLp.frequency.value = 4500; echo.delayTime.value = Math.min(1.5, (60 / (A.bpm || 100)) * 0.75);
  bus.connect(echoSend).connect(fxHp(200)).connect(echo).connect(echoLp).connect(echoFb).connect(echo); echoLp.connect(echoRet).connect(voiceOut);
  const voiceVol = c.createGain(), monitor = c.createGain();
  voiceOut.connect(voiceVol).connect(monitor).connect(master);
  const recorder = new AudioWorkletNode(c, 'take-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  voiceVol.connect(recorder).connect(sink);
  const rawRec = new AudioWorkletNode(c, 'take-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  rawRec.connect(sink);

  let verbType = '';
  function applySound() {
    const p = P(), t = c.currentTime;
    tuner.port.postMessage({ type: 'settings', settings: { ...p, tonic: key.tonic, scale: key.scale, latencyComp: roundTrip(), inputProcessing: false, autoLevel: false, inputGainDb: S.boost, lowCut: S.lowCut, hum: S.hum, deboom: S.deboom, couplingMax: S.setup === 'speakers' ? 1 : 0.06 } });
    low.gain.setTargetAtTime(p.warmth, t, 0.03); pres.gain.setTargetAtTime(p.presence, t, 0.03); air.gain.setTargetAtTime(p.air, t, 0.03);
    comp.threshold.setTargetAtTime(-8 - 26 * p.comp, t, 0.03); comp.ratio.setTargetAtTime(1.5 + 6 * p.comp, t, 0.03);
    makeup.gain.setTargetAtTime(1 + 1.1 * p.comp, t, 0.03);
    dbl.gain.setTargetAtTime(p.doubler * 0.7, t, 0.03);
    if (verbType !== p.reverbType) { verbType = p.reverbType; verb.buffer = makeIR(c, verbType); }
    verbSend.gain.setTargetAtTime(p.reverb, t, 0.03); verbRet.gain.value = 0.9;
    echoSend.gain.setTargetAtTime(p.echo * 0.6, t, 0.03); echoFb.gain.setTargetAtTime(0.25 + 0.2 * p.echo, t, 0.03); echoRet.gain.value = 0.8;
    voiceVol.gain.setTargetAtTime(S.voiceVol, t, 0.03);
    applyDuck();
    monitor.gain.setTargetAtTime(S.monitor && S.setup !== 'speakers' && !listen ? 1 : 0, t, 0.02);
    takeGain.gain.setTargetAtTime(listen ? 1 : 0, t, 0.02);
  }
  tuner.port.postMessage({ type: 'notes', notes: S.mode === 'reference' ? notes : [] });
  // "make room for my voice": the music dips a little (−3 dB) while you sing
  let singingNow = false;
  function applyDuck() {
    const d = S.duck && singingNow && !listen ? 0.7 : 1, t = c.currentTime;
    band.gain.setTargetAtTime(S.bandVol * d, t, singingNow ? 0.08 : 0.45);
    guide.gain.setTargetAtTime(S.guideVol * d, t, singingNow ? 0.08 : 0.45);
  }

  // ---------------------------------------------------------------- microphone
  let stream = null, micSrc = null, inLatency = 0.01, mics = [], outLabel = '';
  const roundTrip = () => (S.rtFor === S.micId && S.rt ? S.rt : (c.baseLatency || 0.005) + (c.outputLatency || 0.015) + inLatency);
  async function startMic() {
    stopMic();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: S.micId ? { exact: S.micId } : undefined,
        // Headphones: untouched, lowest delay. Speakers: the browser's echo canceller removes the music
        // Mixtape is playing from the microphone, and noise suppression removes steady room noise.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
      } });
    } catch (e) {
      if (S.micId) { S.micId = ''; persist(); return startMic(); }
      micError = e.name === 'NotAllowedError' ? 'Mixtape isn’t allowed to use the microphone. In Windows Settings → Privacy & security → Microphone, allow desktop apps, then try again.'
        : e.name === 'NotFoundError' ? 'No microphone found. Plug one in (a headset mic works too), then try again.' : e.message;
      renderMic(); return false;
    }
    micError = '';
    const tr = stream.getAudioTracks()[0];
    inLatency = tr.getSettings?.().latency || 0.01;
    micSrc = c.createMediaStreamSource(stream);
    micSrc.connect(hp); micSrc.connect(rawRec);
    const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    outLabel = (devs.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default') || devs.find((d) => d.kind === 'audiooutput'))?.label || '';
    S.micId = tr.getSettings?.().deviceId || S.micId; persist();
    applySound(); renderMic();
    return true;
  }
  function stopMic() { try { micSrc?.disconnect(); } catch {} stream?.getTracks().forEach((t) => t.stop()); stream = null; micSrc = null; }
  let micError = '';

  // ---------------------------------------------------------------- clock & live pitch frames
  const postClock = () => tuner.port.postMessage({ type: 'clock', clock: { playing: mp.playing, songTime: mp.offset, ctxTime: mp.startedAt ?? c.currentTime, rate: 1 } });
  const trail = []; // { at (song s), raw, out, target, ref }
  let live = { midi: NaN, target: NaN, shift: 0, source: '' }, procLatency = 0.02, gateOpen = false, level = 0, agcDb = 0, bleeding = false, lowCutHz = 0, humHz = 0;
  const score = { hit: 0, total: 0 };
  const recent = []; // cents vs the song's note, last ~0.6 s
  tuner.port.onmessage = (e) => {
    const m = e.data; if (m.type !== 'frames') return;
    procLatency = m.latency; gateOpen = m.gate; level = m.level; agcDb = 20 * Math.log10(m.agc || 1); bleeding = m.bleed; lowCutHz = m.lowCut; humHz = m.hum;
    if (m.vad !== singingNow) { singingNow = m.vad; applyDuck(); }
    for (const f of m.frames) {
      const at = Number.isFinite(f.song) ? f.song : mp.time() - roundTrip() + (f.t - c.currentTime);
      const ref = f.source === 'song' ? nearestRef(f.midi, at) : null;
      trail.push({ at, raw: f.midi, out: Number.isFinite(f.midi) ? f.midi + f.shift : NaN, target: f.target, fold: ref ? ref.n.midi - f.target : null });
      live = f;
      if (mp.playing && Number.isFinite(f.midi) && hasMelody) {
        const r = ref || nearestRef(f.midi, at);
        if (r) {
          const cents = (f.midi - (r.n.midi + 12 * Math.round((f.midi - r.n.midi) / 12))) * 100;
          score.total++; if (Math.abs(cents) <= 50) { score.hit++; r.n.hit = (r.n.hit || 0) + 1; }
          r.n.seen = (r.n.seen || 0) + 1;
          recent.push({ at, cents });
        }
      }
    }
    while (trail.length && trail[0].at < mp.time() - 12) trail.shift();
    while (recent.length && recent[0].at < at0() - 0.6) recent.shift();
  };
  const at0 = () => mp.time() - roundTrip();
  function nearestRef(midi, at) {
    let best = null;
    for (const n of notes) {
      if (n.start > at + 0.15) break;
      if (n.start + n.dur < at - 0.15) continue;
      const d = Math.abs(midi - (n.midi + 12 * Math.round((midi - n.midi) / 12)));
      if (!best || d < best.d) best = { n, d };
    }
    return best && best.d <= 3 ? best : null;
  }

  // ---------------------------------------------------------------- recording
  let take = null, listen = false, recording = null;
  const rec = { chunks: [], start: -1 };
  recorder.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'chunk') { if (rec.start < 0) rec.start = m.start; rec.chunks.push(m.data); }
    if (m.type === 'stopped' && recording) finishTake();
  };
  // A singing session: Start → music plays and recording runs → End (or the song ends) → save or discard.
  let session = null;
  function resetVisuals() {
    trail.length = 0; recent.length = 0; score.hit = 0; score.total = 0;
    for (const n of notes) { delete n.hit; delete n.seen; }
    live = { midi: NaN, target: NaN, shift: 0, source: '' };
  }
  async function startSession() {
    if (!stream && !(await startMic())) return shell.toast('Turn on your microphone first', true);
    if (c.state === 'suspended') await c.resume();
    closeDone();
    listen = false; take = null; mp.setParts('take', takeGain, []);
    resetVisuals();
    let at = mp.time(); if (at >= mix.duration - 1) at = 0;
    mp.play(at); postClock();
    session = { startAt: at };
    rec.chunks = []; rec.start = -1;
    recording = { clock: { songTime: mp.offset, ctxTime: mp.startedAt }, rt: roundTrip() };
    recorder.port.postMessage({ cmd: 'start' });
    applySound(); renderTransport();
  }
  function endSession() {
    if (!session) return;
    mp.pause(); postClock();
    if (recording) recorder.port.postMessage({ cmd: 'stop' }); else afterSession();
    renderTransport();
  }
  function finishTake() {
    const r = recording; recording = null;
    const len = rec.chunks.reduce((n, ch) => n + ch[0].length, 0);
    if (len >= c.sampleRate * 1.5) {
      const buf = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); let o = 0; for (const part of rec.chunks) { d.set(part[ch], o); o += part[ch].length; } }
      // place the take where it was sung: song position at record time − round trip − processing delay
      const at = r.clock.songTime + (rec.start / c.sampleRate - r.clock.ctxTime) - r.rt - procLatency;
      take = { buffer: buf, at, saved: false };
      mp.setParts('take', takeGain, [{ buffer: buf, at }]);
    }
    afterSession();
  }
  function afterSession() {
    const sess = session; session = null;
    if (sess) mp.seek(sess.startAt);
    renderTransport();
    if (!take) return shell.toast('That take was too short to keep');
    showDone();
  }
  function listenBack(on = !listen) {
    if (!take || session) return;
    listen = on;
    if (listen) { mp.play(Math.max(0, take.at)); postClock(); } else { mp.pause(); postClock(); }
    applySound(); renderTransport(); renderDone();
  }
  function seek(t) { if (session) return; if (listen) listenBack(false); mp.seek(t); postClock(); renderTransport(); }

  // ---------------------------------------------------------------- "save or discard?" after singing
  let doneEl = null;
  function showDone() {
    closeDone();
    doneEl = document.createElement('div');
    doneEl.className = 'sg-done';
    const acc = score.total > 30 ? Math.round((score.hit / score.total) * 100) : null;
    doneEl.innerHTML = `<div class="sg-done-card">
      <div class="sg-done-icon">🎤</div>
      <h3>${acc != null && acc >= 75 ? 'Great singing!' : 'Nice singing!'}</h3>
      <div class="sg-done-stats">${acc != null ? `<div><b data-notr>${acc}%</b><span>Accuracy</span></div>` : ''}<div><b data-notr>${fmtTime(take.buffer.duration)}</b><span>Recorded</span></div></div>
      <p>Do you want to keep this recording?</p>
      <button class="chip-btn" id="sgDoneListen">▶ <span>Listen first</span></button>
      <div class="sg-done-actions"><button class="chip-btn" id="sgDoneDiscard">Discard</button><button class="primary" id="sgDoneSave">⬇ Save</button></div>
    </div>`;
    el.querySelector('.sg').appendChild(doneEl);
    doneEl.querySelector('#sgDoneListen').onclick = () => listenBack();
    doneEl.querySelector('#sgDoneDiscard').onclick = () => {
      if (listen) listenBack(false);
      take = null; mp.setParts('take', takeGain, []);
      closeDone(); renderTransport(); shell.toast('Recording discarded');
    };
    doneEl.querySelector('#sgDoneSave').onclick = async () => {
      if (listen) listenBack(false);
      if (await exportMix()) { take.saved = true; closeDone(); renderTransport(); }
    };
  }
  function renderDone() {
    const b = doneEl?.querySelector('#sgDoneListen span');
    if (b) b.textContent = listen ? 'Stop' : 'Listen first';
  }
  function closeDone() { doneEl?.remove(); doneEl = null; }

  // ---------------------------------------------------------------- latency measurement (clicks through the speakers)
  async function measure() {
    if (!stream) return shell.toast('Turn on your microphone first', true);
    const btn = el.querySelector('#sgMeasure'); btn.disabled = true; btn.textContent = 'Listening…';
    if (session) { btn.disabled = false; btn.textContent = 'Measure'; return shell.toast('End singing first'); }
    if (listen) listenBack(false);
    monitor.gain.value = 0;
    const chunks = []; let start = -1;
    rawRec.port.onmessage = (e) => { if (e.data.type === 'chunk') { if (start < 0) start = e.data.start; chunks.push(e.data.data[0]); } };
    rawRec.port.postMessage({ cmd: 'start' });
    const click = c.createBuffer(1, Math.round(c.sampleRate * 0.004), c.sampleRate);
    click.getChannelData(0).forEach((_, i, a) => { a[i] = (i % 2 ? 1 : -1) * 0.9 * (1 - i / a.length); });
    const t0 = c.currentTime + 0.4, times = [];
    for (let k = 0; k < 8; k++) { const s = c.createBufferSource(); s.buffer = click; s.connect(c.destination); s.start(t0 + k * 0.45); times.push(t0 + k * 0.45); }
    await new Promise((r) => setTimeout(r, 4400));
    rawRec.port.postMessage({ cmd: 'stop' });
    await new Promise((r) => setTimeout(r, 200));
    rawRec.port.onmessage = null;
    const x = new Float32Array(chunks.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of chunks) { x.set(a, o); o += a.length; }
    let peak = 0, prev = 0; const hpx = new Float32Array(x.length);
    for (let i = 1; i < x.length; i++) { hpx[i] = x[i] - x[i - 1]; prev = Math.abs(hpx[i]); if (prev > peak) peak = prev; }
    const delays = [];
    for (const t of times) {
      const from = Math.round((t - start / c.sampleRate) * c.sampleRate);
      for (let i = Math.max(0, from); i < Math.min(x.length, from + c.sampleRate * 0.3); i++) {
        if (Math.abs(hpx[i]) > peak * 0.35) { delays.push((i - from) / c.sampleRate); break; }
      }
    }
    delays.sort((a, b) => a - b);
    const med = delays[Math.floor(delays.length / 2)];
    const spread = delays.length >= 5 ? delays[delays.length - 2] - delays[1] : 1;
    btn.disabled = false; btn.textContent = 'Measure';
    applySound();
    if (delays.length >= 5 && spread < 0.006 && med > 0.003) {
      S.rt = med; S.rtFor = S.micId; persist(); applySound(); renderMic();
      shell.toast(`Measured: ${Math.round(med * 1000)} ms`);
    } else shell.toast('Couldn’t hear the clicks clearly. Turn the volume up, hold the headphones near the microphone (or use speakers), and try again.', true);
  }

  // ---------------------------------------------------------------- layout
  const sl = (id, label, min, max, step, value, fmt = (v) => v) => `<label class="sg-sl"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><b data-notr id="${id}V">${fmt(value)}</b></label>`;
  el.innerHTML = `
  <div class="sg">
    <div class="sg-stage">
      <canvas id="sgCanvas"></canvas>
      <div class="sg-readout">
        <div class="sg-note" data-notr id="sgNote">–</div>
        <div class="sg-meter"><i id="sgNeedle"></i></div>
        <div class="sg-tip" id="sgTip">Sing along to see your pitch</div>
      </div>
      <div class="sg-score"><span>Accuracy</span> <b data-notr id="sgScore">–</b></div>
      <div class="sg-legend"><span class="lg-ref">Original melody</span><span class="lg-raw">Your voice</span><span class="lg-out">After correction</span></div>
    </div>
    <div class="sg-transport">
      <button class="sg-start" id="sgStart" title="The music plays and you're recorded (Space)"><i></i><span>Start singing</span></button>
      <button class="chip-btn hidden" id="sgListen">▶ <span>Listen back</span></button>
      <button class="chip-btn accent hidden" id="sgSave">⬇ <span>Save my performance</span></button>
      <span class="st-time"><b data-notr id="sgTime">0:00</b> <span data-notr>/ ${fmtTime(mix.duration)}</span></span>
      <input type="range" id="sgSeek" min="0" max="${mix.duration}" step="0.1" value="0" class="sg-seek">
      <span class="st-facts"><span data-notr>${esc(NOTE_NAMES[A.key.tonic])} ${A.key.mode === 'minor' ? 'm' : ''} · ${Math.round(A.bpm)} BPM</span></span>
    </div>
    <div class="sg-grid">
      <section class="sg-card" id="sgMic"></section>
      <section class="sg-card">
        <h4>Pitch correction</h4>
        <div class="seg" id="sgMode">
          <button data-m="reference" ${hasMelody ? '' : 'disabled'}>Follow the song</button><button data-m="scale">Song key</button><button data-m="off">Off</button>
        </div>
        <p class="cr-hint" id="sgModeHint"></p>
        <div class="sg-row" id="sgKeyRow"><span>Key</span>
          <select id="sgTonic" data-notr>${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select>
          <select id="sgScale"><option value="major">major</option><option value="minor">minor</option><option value="chromatic">all notes</option></select>
          <button class="mini" id="sgKeyAuto">Auto</button></div>
        ${sl('sgStrength', 'Strength', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
        ${sl('sgSpeed', 'Speed', 0, 250, 1, 0, (v) => `${v} ms`)}
        <div class="sg-scale"><span>Robotic</span><span>Natural</span></div>
        ${sl('sgVibrato', 'Keep my vibrato', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
        <div class="sg-row"><span>Language style</span>
          <select id="sgLang"><option value="auto">Auto</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option></select></div>
        <p class="cr-hint" id="sgLangHint"></p>
      </section>
      <section class="sg-card">
        <h4>Sound</h4>
        <div class="sg-presets" id="sgPresets">${Object.entries(PRESETS).map(([k, v]) => `<button class="chip-btn" data-p="${k}" title="${esc(v.desc)}">${v.label}</button>`).join('')}</div>
        ${sl('sgReverb', 'Reverb', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
        <div class="sg-row"><span>Reverb type</span><div class="seg small" id="sgVerbType"><button data-v="room">Room</button><button data-v="plate">Stage</button><button data-v="hall">Hall</button></div></div>
        ${sl('sgEcho', 'Echo', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
        ${sl('sgTone', 'Tone', -6, 6, 0.5, 0, (v) => (v > 0 ? `+${v}` : `${v}`))}
        <div class="sg-scale"><span>Warm</span><span>Bright</span></div>
        <details class="sg-adv"><summary>Advanced</summary>
          ${sl('sgWarmth', 'Body', -6, 6, 0.5, 0, (v) => `${v} dB`)}
          ${sl('sgPresence', 'Clarity', -6, 8, 0.5, 0, (v) => `${v} dB`)}
          ${sl('sgAir', 'Air', -6, 8, 0.5, 0, (v) => `${v} dB`)}
          ${sl('sgComp', 'Evenness', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
          ${sl('sgDeess', 'Soften “s” sounds', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
          ${sl('sgDoubler', 'Double voice', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`)}
          ${sl('sgTol', 'Leave small errors', 0, 50, 1, 0, (v) => `${v}¢`)}
          <button class="link" id="sgResetSound">Reset to preset</button>
        </details>
      </section>
      <section class="sg-card">
        <h4>Mix</h4>
        ${sl('sgVoiceVol', 'My voice', 0, 2, 0.01, S.voiceVol, (v) => `${Math.round(v * 100)}%`)}
        ${sl('sgGuideVol', 'Original singer', 0, 1, 0.01, S.guideVol, (v) => `${Math.round(v * 100)}%`)}
        ${sl('sgBandVol', 'Music', 0, 1.2, 0.01, S.bandVol, (v) => `${Math.round(v * 100)}%`)}
        <p class="cr-hint">Keep a little of the original singer to follow along, or turn it off for pure karaoke.</p>
      </section>
    </div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  // ---------------------------------------------------------------- controls
  const BIND = {
    sgStrength: 'strength', sgSpeed: 'speedMs', sgVibrato: 'vibrato', sgReverb: 'reverb', sgEcho: 'echo',
    sgWarmth: 'warmth', sgPresence: 'presence', sgAir: 'air', sgComp: 'comp', sgDeess: 'deessAmount', sgDoubler: 'doubler', sgTol: 'toleranceCents',
  };
  const showVal = (id, v) => {
    const f = { sgStrength: (x) => `${Math.round(x * 100)}%`, sgSpeed: (x) => `${x} ms`, sgTol: (x) => `${x}¢`, sgGate: (x) => `${x} dB`, sgWarmth: (x) => `${x} dB`, sgPresence: (x) => `${x} dB`, sgAir: (x) => `${x} dB`, sgTone: (x) => (x > 0 ? `+${x}` : `${x}`) }[id] || ((x) => `${Math.round(x * 100)}%`);
    $(`#${id}V`).textContent = f(Number(v));
  };
  function renderControls() {
    const p = P();
    for (const [id, k] of Object.entries(BIND)) { $(`#${id}`).value = p[k]; showVal(id, p[k]); }
    $('#sgTone').value = toneOf(p); showVal('sgTone', $('#sgTone').value);
    el.querySelectorAll('#sgPresets button').forEach((b) => b.classList.toggle('on', b.dataset.p === S.preset));
    el.querySelectorAll('#sgVerbType button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.reverbType));
    el.querySelectorAll('#sgMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === S.mode));
    $('#sgModeHint').textContent = S.mode === 'reference' ? 'Your voice is guided to the original singer’s notes. Singing an octave higher or lower is fine.'
      : S.mode === 'scale' ? 'Your voice is guided to the nearest note in the song’s key.'
      : hasMelody ? 'No pitch correction. Effects still apply.' : 'No pitch correction. Effects still apply.';
    $('#sgKeyRow').classList.toggle('dim', S.mode === 'off');
    $('#sgTonic').value = key.tonic; $('#sgScale').value = key.scale;
    $('#sgLang').value = S.lang;
    $('#sgLangHint').innerHTML = S.lang === 'auto' ? `<span>Detected:</span> <span data-notr>${LANGS[lang()].label}</span>` : '';
    for (const id of ['sgStrength', 'sgSpeed', 'sgVibrato']) $(`#${id}`).disabled = S.mode === 'off';
    for (const id of ['sgVoiceVol', 'sgGuideVol', 'sgBandVol']) showVal(id, $(`#${id}`).value);
  }
  el.querySelectorAll('.sg-sl input').forEach((inp) => inp.addEventListener('input', () => {
    const v = Number(inp.value); showVal(inp.id, v);
    if (BIND[inp.id]) S.overrides[BIND[inp.id]] = v;
    else if (inp.id === 'sgTone') { // one knob for beginners: tilts clarity/air against body
      const base = effective({ preset: S.preset, lang: lang(), overrides: {} });
      const d = v - toneOf(base);
      Object.assign(S.overrides, { presence: base.presence + d, air: base.air + d, warmth: base.warmth - d / 2 });
      for (const id of ['sgWarmth', 'sgPresence', 'sgAir']) { $(`#${id}`).value = S.overrides[BIND[id]]; showVal(id, S.overrides[BIND[id]]); }
    } else if (inp.id === 'sgVoiceVol') S.voiceVol = v;
    else if (inp.id === 'sgGuideVol') S.guideVol = v;
    else if (inp.id === 'sgBandVol') S.bandVol = v;
    persist(); applySound();
  }));
  $('#sgPresets').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; S.preset = b.dataset.p; S.overrides = {}; persist(); renderControls(); applySound(); };
  $('#sgResetSound').onclick = () => { S.overrides = {}; persist(); renderControls(); applySound(); };
  $('#sgVerbType').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; S.overrides.reverbType = b.dataset.v; persist(); renderControls(); applySound(); };
  $('#sgMode').onclick = (e) => {
    const b = e.target.closest('[data-m]'); if (!b || b.disabled) return;
    S.mode = b.dataset.m; persist();
    tuner.port.postMessage({ type: 'notes', notes: S.mode === 'reference' ? notes : [] });
    renderControls(); applySound();
  };
  const setKey = () => { key.tonic = Number($('#sgTonic').value); key.scale = $('#sgScale').value; S.keyFor = track.id; S.tonic = key.tonic; S.scale = key.scale; persist(); applySound(); };
  $('#sgTonic').onchange = setKey; $('#sgScale').onchange = setKey;
  $('#sgKeyAuto').onclick = () => { key.tonic = A.key.tonic; key.scale = A.key.mode; S.keyFor = ''; persist(); renderControls(); applySound(); };
  $('#sgLang').onchange = () => { S.lang = $('#sgLang').value; S.overrides = {}; persist(); renderControls(); applySound(); };

  $('#sgStart').onclick = () => (session ? endSession() : startSession());
  $('#sgListen').onclick = () => listenBack();
  $('#sgSave').onclick = async () => { if (await exportMix()) { take.saved = true; renderTransport(); } };
  $('#sgSeek').oninput = (e) => seek(Number(e.target.value));

  function renderTransport() {
    const b = $('#sgStart');
    b.classList.toggle('live', !!session);
    b.querySelector('span').textContent = session ? 'End singing' : take ? 'Sing again' : 'Start singing';
    $('#sgListen').classList.toggle('hidden', !take || !!session); $('#sgListen').classList.toggle('on', listen);
    $('#sgListen').querySelector('span').textContent = listen ? 'Stop' : 'Listen back';
    $('#sgSave').classList.toggle('hidden', !take || !!session || !take.saved);
    $('#sgSeek').disabled = !!session;
    el.querySelector('.sg-stage').classList.toggle('live', !!session);
  }

  function latencyInfo() {
    const ms = Math.round((roundTrip() + procLatency) * 1000);
    const bt = isBluetooth(outLabel);
    return { ms, bt, grade: bt ? 'bad' : ms <= 35 ? 'good' : ms <= 60 ? 'ok' : 'bad', measured: S.rtFor === S.micId && !!S.rt };
  }
  function renderMic() {
    const box = $('#sgMic'); if (!box) return;
    if (!stream) {
      box.innerHTML = `<h4>Your voice</h4>
        <p>Put on wired headphones, then turn on your microphone. Without headphones the microphone hears the music too.</p>
        ${micError ? `<p class="sg-warn">${esc(micError)}</p>` : ''}
        <button class="primary" id="sgMicOn">🎤 Turn on microphone</button>
        <p class="cr-hint">Everything runs on your PC. Your voice is never uploaded.</p>`;
      box.querySelector('#sgMicOn').onclick = async () => { if (c.state === 'suspended') await c.resume(); startMic(); };
      return;
    }
    const L = latencyInfo();
    box.innerHTML = `<h4>Your voice</h4>
      <div class="sg-row"><span>Microphone</span><select id="sgMicSel" data-notr>${mics.map((m) => `<option value="${esc(m.deviceId)}" ${m.deviceId === S.micId ? 'selected' : ''}>${esc(m.label || 'Microphone')}</option>`).join('')}</select></div>
      <div class="sg-level"><i id="sgLevel"></i></div>
      <label class="sg-sl"><span>Mic volume</span><input type="range" id="sgBoost" min="-12" max="24" step="1" value="${S.boost}"><b data-notr id="sgBoostV">${S.boost > 0 ? '+' : ''}${S.boost} dB</b></label>
      <p class="cr-hint">Your microphone is used as it is, with your Windows sound settings. Set its level in Windows (Sound settings → Input) or here.</p>
      <label class="tog sg-row"><input type="checkbox" id="sgMonitor" ${S.monitor ? 'checked' : ''}> <span>Hear myself in headphones</span></label>
      <div class="sg-lat ${L.grade}"><span>Delay</span> <b data-notr id="sgLatMs">${L.ms} ms</b> <span id="sgLatWord">${L.grade === 'good' ? 'Great' : L.grade === 'ok' ? 'OK' : 'High'}</span>
        <button class="mini" id="sgMeasure" title="Plays a few clicks and listens for them to measure the exact delay">Measure</button></div>
      <p class="cr-hint" id="sgLatHint">${L.bt ? 'Bluetooth headphones add a long delay. For live singing use wired headphones, or turn off “Hear myself”, record, and use Listen back.' : L.grade === 'bad' ? 'The delay is high. Wired headphones and closing other audio apps help. You can also turn off “Hear myself” and use Listen back.' : L.measured ? 'Measured on this PC.' : 'Estimated. Press Measure for the exact figure (hold the headphones near the microphone).'}</p>
      <p class="sg-level-tip cr-hint" id="sgGateHint"></p>`;
    box.querySelector('#sgMicSel').onchange = (e) => { S.micId = e.target.value; persist(); startMic(); };
    box.querySelector('#sgMonitor')?.addEventListener('change', (e) => { S.monitor = e.target.checked; persist(); applySound(); });
    box.querySelector('#sgBoost').oninput = (e) => { S.boost = Number(e.target.value); box.querySelector('#sgBoostV').textContent = `${S.boost > 0 ? '+' : ''}${S.boost} dB`; persist(); applySound(); };
    box.querySelector('#sgMeasure')?.addEventListener('click', measure);
  }

  // ---------------------------------------------------------------- export
  async function exportMix() {
    if (!take) return false;
    const btn = doneEl?.querySelector('#sgDoneSave') || $('#sgSave'); btn.disabled = true;
    try {
      const len = Math.ceil(mix.duration * SR);
      const off = new OfflineAudioContext(2, len, SR);
      const lim = off.createDynamicsCompressor(); lim.threshold.value = -2; lim.ratio.value = 14; lim.attack.value = 0.002; lim.release.value = 0.12; lim.connect(off.destination);
      const add = (buffer, gain, at = 0) => {
        const s = off.createBufferSource(); s.buffer = buffer; const g = off.createGain(); g.gain.value = gain;
        s.connect(g).connect(lim);
        if (at >= 0) s.start(at); else s.start(0, -at);
      };
      for (const k of ['drums', 'bass', 'guitar', 'piano', 'other']) add(stems[k], S.bandVol);
      if (S.guideVol > 0) add(stems.vocals, S.guideVol);
      add(take.buffer, 1, take.at);
      const out = await off.startRendering();
      const blob = encodeWav(out);
      download(blob, `${track.title} – my version.wav`);
      shell.toast('Saved your performance as a WAV file');
      saveInspiration(blob, { kind: 'sing', title: `${track.title} (my singing)`, track, durationSec: out.duration }, shell.toast);
      btn.disabled = false;
      return true;
    } catch (e) { shell.toast(e.message, true); btn.disabled = false; return false; }
  }

  // ---------------------------------------------------------------- drawing
  const canvas = $('#sgCanvas');
  const lo0 = notes.length ? Math.min(...notes.map((n) => n.midi)) : 52, hi0 = notes.length ? Math.max(...notes.map((n) => n.midi)) : 72;
  const lo = Math.min(lo0, (lo0 + hi0) / 2 - 7) - 2, hi = Math.max(hi0, (lo0 + hi0) / 2 + 7) + 2;
  const fold = (m) => { if (!Number.isFinite(m)) return m; while (m < lo) m += 12; while (m > hi) m -= 12; return m; };
  let raf = 0, lastLatUpdate = 0, musicTick = 0;
  function draw() {
    raf = requestAnimationFrame(draw);
    const now = mp.time();
    $('#sgTime').textContent = fmtTime(now);
    if (document.activeElement !== $('#sgSeek')) $('#sgSeek').value = now;
    if (mp.playing && now >= mix.duration - 0.05) { if (session) endSession(); else if (listen) listenBack(false); else { mp.pause(); postClock(); } }
    if (++musicTick % 2 === 0) { // music level for the bleed guard (~30×/s)
      let e = 0;
      if (mp.playing) { musicMeter.getFloatTimeDomainData(musicBuf); for (let i = 0; i < musicBuf.length; i++) e += musicBuf[i] * musicBuf[i]; }
      tuner.port.postMessage({ type: 'music', rms: Math.sqrt(e / musicBuf.length) });
    }
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const span = 8, px = w * 0.32, t0 = now - roundTrip() - span * 0.32;
    const X = (t) => ((t - t0) / span) * w, rows = hi - lo, Y = (m) => h - ((m - lo) / rows) * (h - 24) - 12;
    // grid
    g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const inKey = (SCALE_PCS[key.scale] || SCALE_PCS.chromatic).includes((((m - key.tonic) % 12) + 12) % 12);
      g.fillStyle = m % 12 === 0 ? 'rgba(255,255,255,.10)' : inKey ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.015)';
      g.fillRect(0, Y(m), w, 1);
      if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillText(noteName(m), 6, Y(m) - 7); }
    }
    // the original singer's notes
    const rh = Math.max(4, (h - 24) / rows * 0.7);
    for (const n of notes) {
      if (n.start + n.dur < t0) continue; if (n.start > t0 + span) break;
      const x0 = X(n.start), x1 = X(n.start + n.dur), y = Y(n.midi);
      const acc = n.seen ? n.hit / n.seen : -1;
      g.fillStyle = acc < 0 ? 'rgba(163,152,143,.28)' : acc > 0.6 ? 'rgba(127,209,139,.55)' : acc > 0.3 ? 'rgba(230,200,79,.5)' : 'rgba(255,107,107,.42)';
      roundRect(g, x0, y - rh / 2, Math.max(3, x1 - x0), rh, rh / 2); g.fill();
    }
    // playhead
    g.fillStyle = 'rgba(255,122,69,.55)'; g.fillRect(px, 0, 2, h);
    // trails: raw voice (thin) and corrected (bright)
    const line = (key2, style, width) => {
      g.strokeStyle = style; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
      let pen = false, prevAt = -1;
      for (const f of trail) {
        let m = f[key2]; if (!Number.isFinite(m) || f.at < t0) { pen = false; continue; }
        m = f.fold != null ? m + f.fold : fold(m);
        const x = X(f.at), y = Y(m);
        if (pen && f.at - prevAt < 0.05) g.lineTo(x, y); else g.moveTo(x, y);
        pen = true; prevAt = f.at;
      }
      g.stroke();
    };
    line('raw', 'rgba(243,236,230,.45)', 1.5);
    if (S.mode !== 'off') line('out', '#ff7a45', 3);
    // readout
    const m = live.midi, tg = live.target;
    $('#sgNote').textContent = Number.isFinite(tg) ? noteName(tg) : Number.isFinite(m) ? noteName(m) : '–';
    const cents = Number.isFinite(m) && Number.isFinite(tg) ? Math.round((m - tg) * 100) : null;
    const needle = $('#sgNeedle');
    needle.style.left = `${50 + Math.max(-50, Math.min(50, cents ?? 0))}%`;
    needle.className = cents == null ? 'off' : Math.abs(cents) <= 20 ? 'good' : Math.abs(cents) <= 45 ? 'ok' : 'bad';
    while (recent.length && recent[0].at < at0() - 0.6) recent.shift();
    if (recent.length > 6 && mp.playing) {
      const avg = recent.reduce((s, r) => s + r.cents, 0) / recent.length;
      setTip(Math.abs(avg) <= 25 ? 'Spot on!' : avg > 0 ? 'A little high' : 'A little low');
    } else setTip(stream ? (gateOpen ? 'Listening…' : 'Sing along to see your pitch') : 'Turn on your microphone to start');
    $('#sgScore').textContent = score.total > 30 ? `${Math.round((score.hit / score.total) * 100)}%` : '–';
    const cn = $('#sgCutNow'); if (cn) cn.textContent = S.lowCut === 'auto' && lowCutHz ? `${lowCutHz} Hz` : '';
    const hn = $('#sgHumNow'); if (hn) hn.textContent = S.hum === 'auto' ? (humHz ? `✓ ${humHz} Hz` : '–') : '';
    const ag = $('#sgAgc'); if (ag) ag.textContent = S.autoLevel ? `+${Math.max(0, Math.round(agcDb))} dB` : '';
    $('#sgBleed')?.classList.toggle('hidden', !bleeding || !mp.playing);
    const lv = $('#sgLevel'); if (lv) { const db = 20 * Math.log10(level + 1e-6); lv.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`; lv.className = db > -4 ? 'hot' : ''; }
    if (stream && performance.now() - lastLatUpdate > 1000) {
      lastLatUpdate = performance.now();
      const L = latencyInfo(), ms = $('#sgLatMs');
      if (ms) { ms.textContent = `${L.ms} ms`; $('#sgLatWord').textContent = L.grade === 'good' ? 'Great' : L.grade === 'ok' ? 'OK' : 'High'; ms.parentElement.className = `sg-lat ${L.grade}`; }
      const gh = $('#sgGateHint'); if (gh) gh.textContent = level > 0.7 ? 'Your microphone is very loud. Move back a little or lower its level in Windows.' : '';
    }
  }
  let tipText = '';
  const setTip = (t) => { if (t !== tipText) { tipText = t; $('#sgTip').textContent = t; } };
  const SCALE_PCS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };

  const onKey = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); if (doneEl) return; session ? endSession() : startSession(); }
  };
  document.addEventListener('keydown', onKey);

  renderControls(); renderTransport(); renderMic(); applySound();
  draw();
  // A previous visit already allowed the microphone: turn it on straight away.
  navigator.permissions?.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted' && !destroyed) startMic(); }).catch(() => {});

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      try { mp.pause(); } catch {}
      stopMic();
      dblParts.forEach((d) => { try { d.lfo.stop(); } catch {} });
      c.close().catch(() => {});
    },
  };
}

const toneOf = (p) => Math.max(-6, Math.min(6, Math.round(((p.presence + p.air) / 2 - 2) * 2) / 2));

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
