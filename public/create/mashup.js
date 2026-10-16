// Mashup: take parts from two songs, auto-match tempo and key, line them up on the beat.
import {
  audio, ensureWorklet, showDevice, STEM_INFO, STEM_ORDER, loadMix, loadStems, analyzeTrack, makeChain, MultiPlayer,
  fmtTime, transformBuffer, encodeWav, download, saveInspiration, SR,
} from './core.js';
import { compatibility } from '/dsp/analyze.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRESETS = [
  { name: "B's vocals on A's beat", pick: { vocals: 'B', drums: 'A', bass: 'A', guitar: 'A', piano: 'A', other: 'A' } },
  { name: "A's vocals on B's beat", pick: { vocals: 'A', drums: 'B', bass: 'B', guitar: 'B', piano: 'B', other: 'B' } },
  { name: 'Drum swap', pick: { vocals: 'A', drums: 'B', bass: 'A', guitar: 'A', piano: 'A', other: 'A' } },
  { name: 'Melodies from B', pick: { vocals: 'A', drums: 'A', bass: 'A', guitar: 'B', piano: 'B', other: 'B' } },
  { name: 'Everything from both', pick: Object.fromEntries(STEM_ORDER.map((s) => [s, 'AB'])) },
];

export async function createMashup(el, shell) {
  const { ctx, master } = audio();
  await ensureWorklet();
  let destroyed = false, raf = 0;
  const A = { track: shell.track }, B = { track: null };
  const S = { pick: { ...PRESETS[0].pick }, matchTempo: true, matchKey: true, secA: 0, secB: 0, nudge: 0, volA: 1, volB: 1, processing: false };
  const player = new MultiPlayer(ctx);
  const chains = {};
  for (const n of STEM_ORDER) for (const side of ['A', 'B']) chains[n + side] = makeChain(ctx, master.input, { withPitch: false });

  const loadSide = async (side, track, onP) => {
    side.track = track;
    const [mix, stems] = await Promise.all([loadMix(track), loadStems(track, onP)]);
    side.mix = mix; side.stems = stems;
    side.an = await analyzeTrack(track, mix, stems);
  };

  el.innerHTML = `<div class="cr-loading"><div class="spinner big"></div><h3>Preparing song A…</h3><p id="mxLoad"></p></div>`;
  await loadSide(A, A.track, (p) => { const t = el.querySelector('#mxLoad'); if (t) t.textContent = p.text; showDevice(el, p); });
  if (destroyed) return { destroy() {} };

  let bStems = null, bKey = '', job = null, jobKey = '';
  /** Stretch/shift song B's parts to fit song A. Parts you're listening to are done first. */
  function processB() {
    if (!B.an) return Promise.resolve();
    const tempoRatio = S.matchTempo ? bestTempoRatio(A.an.bpm, B.an.bpm) : 1;
    const semitones = S.matchKey ? compatibility(A.an, B.an).keyShift : 0;
    const key = `${B.track.id}|${tempoRatio.toFixed(4)}|${semitones}`;
    if (key === bKey) { layout(); return Promise.resolve(); }
    if (job && jobKey === key) return job;
    jobKey = key;
    job = (async () => {
      S.processing = true; render();
      B.ratio = tempoRatio; B.semis = semitones;
      const out = {};
      const order = [...STEM_ORDER].sort((x, y) => S.pick[y].includes('B') - S.pick[x].includes('B'));
      for (const n of order) {
        out[n] = (tempoRatio === 1 && semitones === 0) ? B.stems[n] : await transformBuffer(B.stems[n], { tempoRatio, semitones }, (p) => {
          const t = el.querySelector('#mxProc'); if (t) t.textContent = `Matching song B to song A… ${Math.round(((Object.keys(out).length + p) / 6) * 100)}%`;
        });
        if (destroyed || jobKey !== key) return;
        bStems = { ...out }; layout(); // hear each part as soon as it's ready
      }
      bKey = key; S.processing = false; layout(); render();
    })().finally(() => { if (jobKey === key) job = null; });
    return job;
  }

  function bestTempoRatio(a, b) {
    // tempoRatio > 1 speeds B up. Allow half/double time so 70 and 140 BPM mix naturally.
    return [a / b, (a / 2) / b, (a * 2) / b].sort((x, y) => Math.abs(Math.log(x)) - Math.abs(Math.log(y)))[0];
  }

  /** Where B starts on A's timeline so B's chosen section lands on A's chosen section, on the beat. */
  function bOffset() {
    const ratio = B.ratio || 1;
    const aSec = A.an.sections[S.secA], bSec = B.an.sections[S.secB];
    const aAnchor = aSec.start < A.an.downbeat ? A.an.downbeat : aSec.start;
    const bAnchor = (bSec.start < B.an.downbeat ? B.an.downbeat : bSec.start) / ratio;
    return aAnchor - bAnchor + (S.nudge * 60) / A.an.bpm;
  }

  function layout() {
    if (destroyed) return;
    const off = B.an ? bOffset() : 0;
    for (const n of STEM_ORDER) {
      player.setParts(n + 'A', chains[n + 'A'].input, S.pick[n].includes('A') ? [{ buffer: A.stems[n], at: 0 }] : []);
      player.setParts(n + 'B', chains[n + 'B'].input, bStems && S.pick[n].includes('B') ? [{ buffer: bStems[n], at: off }] : []);
      chains[n + 'A'].volume.gain.value = S.volA;
      chains[n + 'B'].volume.gain.value = S.volB;
    }
    player.duration = A.mix.duration;
    if (player.playing) player.play(player.time());
  }

  function render() {
    const c = B.an ? compatibility(A.an, B.an) : null;
    el.innerHTML = `
      <div class="mx-songs">
        ${songCard('A', A)}
        <div class="mx-plus">+</div>
        ${B.track ? songCard('B', B) : `<button class="mx-pick" id="mxPickB"><b>+ Choose song B</b><span>Pick any song from your library or search SoundCloud</span></button>`}
      </div>
      ${c ? `<div class="mx-fit"><div class="fit-score" style="--s:${c.score}"><b>${c.score}</b></div><div><h3>${c.label}</h3>
        <p>Tempo ${Math.round(A.an.bpm)} vs ${Math.round(B.an.bpm)} BPM${S.matchTempo ? ' → matched' : ''} · Key ${esc(A.an.key.name)} vs ${esc(B.an.key.name)}${S.matchKey && c.keyShift ? ` → song B moved ${c.keyShift > 0 ? 'up' : 'down'} ${Math.abs(c.keyShift)}` : ''}</p></div>
        <label class="tog"><input type="checkbox" id="mxTempo" ${S.matchTempo ? 'checked' : ''}> Match tempo</label>
        <label class="tog"><input type="checkbox" id="mxKey" ${S.matchKey ? 'checked' : ''}> Match key</label></div>` : ''}
      ${S.processing ? `<div class="ed-status"><span class="spinner"></span><span id="mxProc">Matching song B to song A…</span></div>` : ''}
      ${B.an ? `
      <div class="mx-controls">
        <button class="cr-play" id="mxPlay"><svg viewBox="0 0 24 24" class="i-play"><path d="M8 5v14l11-7z"/></svg><svg viewBox="0 0 24 24" class="i-pause"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg></button>
        <div class="st-time"><b id="mxTime">0:00</b><span> / ${fmtTime(A.mix.duration)}</span></div>
        <label>Drop B's <select id="mxSecB">${B.an.sections.map((s, i) => `<option value="${i}" ${i === S.secB ? 'selected' : ''}>${esc(s.label)} (${fmtTime(s.start)})</option>`).join('')}</select></label>
        <label>at A's <select id="mxSecA">${A.an.sections.map((s, i) => `<option value="${i}" ${i === S.secA ? 'selected' : ''}>${esc(s.label)} (${fmtTime(s.start)})</option>`).join('')}</select></label>
        <span class="ed-inline">Nudge <button id="mxNudgeL">◀</button><b>${S.nudge > 0 ? '+' : ''}${S.nudge} beat${Math.abs(S.nudge) === 1 ? '' : 's'}</b><button id="mxNudgeR">▶</button></span>
        <button class="chip-btn" id="mxExport">⬇ Save mashup</button>
      </div>
      <div class="mx-presets">${PRESETS.map((p, i) => `<button class="chip-btn" data-p="${i}">${esc(p.name)}</button>`).join('')}</div>
      <div class="mx-board">
        <div class="mx-row mx-headrow"><span></span><b>Song A</b><b>Song B</b></div>
        ${STEM_ORDER.map((n) => `<div class="mx-row" style="--c:${STEM_INFO[n].color}"><span class="mx-part">${STEM_INFO[n].icon} ${STEM_INFO[n].label}</span>
          <button class="mx-cell ${S.pick[n].includes('A') ? 'on' : ''}" data-n="${n}" data-s="A">${S.pick[n].includes('A') ? 'On' : 'Off'}</button>
          <button class="mx-cell ${S.pick[n].includes('B') ? 'on' : ''}" data-n="${n}" data-s="B">${S.pick[n].includes('B') ? 'On' : 'Off'}</button></div>`).join('')}
        <div class="mx-row"><span class="mx-part">🔉 Loudness</span><input type="range" min="0" max="150" value="${S.volA * 100}" id="mxVolA"><input type="range" min="0" max="150" value="${S.volB * 100}" id="mxVolB"></div>
      </div>` : '<p class="cr-hint center">Choose a second song to start mixing. Tip: songs with a similar feel and a high match score blend best.</p>'}`;
    wire();
    el.querySelector('#mxPlay')?.classList.toggle('playing', player.playing);
  }
  function songCard(side, s) {
    return `<div class="mx-song ${side}"><span class="mx-badge">${side}</span>${s.track.artwork ? `<img src="${esc(s.track.artwork)}" alt="">` : '<div class="mx-noart"></div>'}
      <div><b data-notr>${esc(s.track.title)}</b><span><i data-notr>${esc(s.track.artist)}</i>${s.an ? ` · ${Math.round(s.an.bpm)} BPM · ${esc(s.an.key.name)}` : ''}</span></div>
      <button class="chip-btn" data-change="${side}">Change</button></div>`;
  }

  async function chooseB(side = 'B') {
    const t = await shell.pickTrack(side === 'B' ? 'Choose song B' : 'Choose song A');
    if (!t || destroyed) return;
    player.pause();
    const target = side === 'A' ? A : B;
    el.querySelector('.mx-songs')?.insertAdjacentHTML('afterend', `<div class="ed-status" id="mxLoading"><span class="spinner"></span><span>Loading…</span></div>`);
    try {
      await loadSide(target, t, (p) => { const x = el.querySelector('#mxLoading span:last-child'); if (x) x.textContent = p.text; });
      S.secA = 0; S.secB = defaultSection(B.an); S.nudge = 0; bKey = ''; bStems = null;
      layout(); render();
      await processB();
    } catch (e) { shell.toast(e.message, true); render(); }
  }
  const defaultSection = (an) => Math.max(0, an?.sections.findIndex((s) => s.label === 'Drop') ?? 0);

  function wire() {
    const $ = (s) => el.querySelector(s);
    $('#mxPickB')?.addEventListener('click', () => chooseB('B'));
    el.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => chooseB(b.dataset.change)));
    $('#mxPlay')?.addEventListener('click', () => { if (player.playing) player.pause(); else player.play(); $('#mxPlay').classList.toggle('playing', player.playing); });
    $('#mxTempo')?.addEventListener('change', (e) => { S.matchTempo = e.target.checked; processB(); });
    $('#mxKey')?.addEventListener('change', (e) => { S.matchKey = e.target.checked; processB(); });
    $('#mxSecA')?.addEventListener('change', (e) => { S.secA = Number(e.target.value); layout(); player.seek(Math.max(0, A.an.sections[S.secA].start - 4)); });
    $('#mxSecB')?.addEventListener('change', (e) => { S.secB = Number(e.target.value); layout(); });
    $('#mxNudgeL')?.addEventListener('click', () => { S.nudge--; layout(); render(); });
    $('#mxNudgeR')?.addEventListener('click', () => { S.nudge++; layout(); render(); });
    $('#mxVolA')?.addEventListener('input', (e) => { S.volA = e.target.value / 100; layout(); });
    $('#mxVolB')?.addEventListener('input', (e) => { S.volB = e.target.value / 100; layout(); });
    el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { S.pick = { ...PRESETS[Number(b.dataset.p)].pick }; layout(); render(); processB(); }));
    el.querySelectorAll('.mx-cell').forEach((b) => b.addEventListener('click', () => {
      const n = b.dataset.n, s = b.dataset.s, cur = S.pick[n];
      S.pick[n] = cur.includes(s) ? cur.replace(s, '') : (s === 'A' ? 'A' + cur : cur + 'B');
      layout(); render(); processB();
    }));
    $('#mxExport')?.addEventListener('click', exportMix);
  }

  async function exportMix() {
    const btn = el.querySelector('#mxExport'); btn.disabled = true; btn.textContent = '⏳ Saving…';
    try {
      const off = new OfflineAudioContext(2, A.mix.length, SR);
      const comp = off.createDynamicsCompressor(); comp.threshold.value = -3; comp.ratio.value = 12; comp.connect(off.destination);
      for (const [id, lane] of player.lanes) {
        const g = off.createGain(); g.gain.value = id.endsWith('A') ? S.volA : S.volB; g.connect(comp);
        for (const p of lane.parts) {
          const s = off.createBufferSource(); s.buffer = p.buffer; s.connect(g);
          if (p.at >= 0) s.start(p.at); else s.start(0, -p.at);
        }
      }
      const out = await off.startRendering(), blob = encodeWav(out), name = `${A.track.title} x ${B.track.title}`;
      download(blob, `${name} (Mixtape mashup).wav`);
      saveInspiration(blob, { kind: 'mashup', title: `${name} (mashup)`, track: A.track, durationSec: out.duration }, shell.toast);
    } catch (e) { shell.toast(e.message, true); }
    btn.disabled = false; btn.textContent = '⬇ Save mashup';
  }

  layout();
  render();
  const tick = () => {
    const t = player.time();
    if (player.playing && t >= A.mix.duration - 0.02) { player.pause(); player.seek(0); el.querySelector('#mxPlay')?.classList.remove('playing'); }
    const tt = el.querySelector('#mxTime'); if (tt) tt.textContent = fmtTime(t);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    destroy() { destroyed = true; cancelAnimationFrame(raf); player.pause(); Object.values(chains).forEach((c) => c.disconnect()); },
  };
}
