// Studio: see the parts of a song, click one, change it, hear it immediately.
import {
  audio, ensureWorklet, showDevice, STEM_INFO, STEM_ORDER, EFFECTS, loadMix, loadStems, analyzeTrack, makeChain, MultiPlayer,
  peaksOf, drawWave, fmtTime, transformBuffer, work, mono, makeBuffer, encodeWav, download, saveInspiration, hexA, SR,
} from './core.js';
import { INSTRUMENTS } from '/dsp/synth.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SPEEDS = [{ v: 0.8, label: 'Slowed' }, { v: 0.9, label: 'A bit slower' }, { v: 1, label: 'Normal' }, { v: 1.12, label: 'A bit faster' }, { v: 1.25, label: 'Sped up' }];
const SECTION_COLORS = { Intro: '#5b8def', Verse: '#7fd18b', 'Build-up': '#ffb36b', Drop: '#ff5d7a', Break: '#39c6d6', Outro: '#a3988f', 'Whole song': '#7b5cff' };

const RECIPES = [
  { name: 'Phonk it up', desc: 'Distorted drums, an 808 bass line and a slowed, roomy feel.', apply: (S) => { S.set('drums', { effect: 'distort' }); S.set('bass', { inst: { name: 'bass808', octave: 0, mode: 'replace', tidy: true } }); S.set('other', { effect: 'reverb' }); S.speed(0.9); } },
  { name: 'Just the voice', desc: 'Only the vocals, in a big room.', apply: (S) => { STEM_ORDER.forEach((n) => S.set(n, { mute: n !== 'vocals', solo: false })); S.set('vocals', { effect: 'reverb' }); } },
  { name: 'Karaoke', desc: 'Everything except the vocals.', apply: (S) => S.set('vocals', { mute: true }) },
  { name: 'Music box dream', desc: 'Piano and melody become a music box, no drums, slower.', apply: (S) => { S.set('piano', { inst: { name: 'bells', octave: 1, mode: 'replace', tidy: true } }); S.set('other', { inst: { name: 'bells', octave: 1, mode: 'layer', tidy: true } }); S.set('drums', { mute: true }); S.set('vocals', { effect: 'reverb' }); S.speed(0.9); } },
  { name: 'Orchestra', desc: 'Piano, guitar and melody played by strings.', apply: (S) => ['piano', 'guitar', 'other'].forEach((n) => S.set(n, { inst: { name: 'strings', octave: 0, mode: 'replace', tidy: false } })) },
  { name: 'Chipmunk', desc: 'Vocals five steps higher.', apply: (S) => S.set('vocals', { pitch: 5 }) },
  { name: 'Deep voice', desc: 'Vocals four steps lower.', apply: (S) => S.set('vocals', { pitch: -4 }) },
  { name: 'Underwater party', desc: 'Drums and bass from under the sea, echoing vocals.', apply: (S) => { S.set('drums', { effect: 'underwater' }); S.set('bass', { effect: 'underwater' }); S.set('vocals', { effect: 'echo' }); } },
  { name: 'Cowbell melody', desc: 'The melody played on a phonk cowbell.', apply: (S) => S.set('other', { inst: { name: 'cowbell', octave: 0, mode: 'layer', tidy: true } }) },
];

export async function createStudio(el, shell) {
  const { ctx, master } = audio();
  const track = shell.track;
  let destroyed = false;
  el.innerHTML = `<div class="cr-loading"><div class="spinner big"></div><h3 id="stLoadTitle">Getting the song ready…</h3><p id="stLoadText">Downloading the song…</p><div class="cr-bar"><i id="stLoadBar"></i></div><p class="cr-hint" id="stLoadHint"></p></div>`;
  let note = '';
  const setLoad = (p) => {
    if (destroyed) return;
    if (p.note) note = p.note;
    el.querySelector('#stLoadText').textContent = p.text || '';
    el.querySelector('#stLoadBar').style.width = `${p.pct ?? (p.stage === 'download' ? 8 : p.stage === 'load' ? 96 : 50)}%`;
    showDevice(el, p);
    el.querySelector('#stLoadHint').textContent = p.stage === 'split'
      ? `${note ? note + ' ' : ''}The AI is separating vocals, drums, bass, guitar, piano and other sounds${p.provider ? ` on your ${p.provider}` : ''}.${p.eta ? ` About ${p.eta}s left.` : ''} This only happens once per song.`
      : '';
  };

  await ensureWorklet();
  const [mix, stems] = await Promise.all([loadMix(track), loadStems(track, setLoad)]);
  if (destroyed) return { destroy() {} };
  setLoad({ stage: 'load', text: 'Reading the beat and key…' });
  const A = await analyzeTrack(track, mix, stems);
  if (destroyed) return { destroy() {} };

  // ---------------------------------------------------------------- state
  const player = new MultiPlayer(ctx);
  player.duration = mix.duration;
  const origChain = ctx.createGain(); origChain.gain.value = 0; origChain.connect(master.input);
  player.setParts('orig', origChain, [{ buffer: mix, at: 0 }]);
  const renderCache = new Map();
  const cacheSet = (k, v) => { renderCache.delete(k); renderCache.set(k, v); while (renderCache.size > 16) renderCache.delete(renderCache.keys().next().value); return v; };

  const lanes = STEM_ORDER.map((name) => {
    const chain = makeChain(ctx, master.input);
    return {
      name, ...STEM_INFO[name], stem: stems[name], peaks: peaksOf(stems[name]), chain,
      vol: 1, pan: 0, mute: false, solo: false, pitch: 0, scope: 'all', region: null, effect: 'none', inst: null,
      status: '', ver: 0, notes: {},
    };
  });
  // nearly silent parts are dimmed (e.g. no piano in this song)
  for (const l of lanes) { let m = 0; for (let i = 0; i < l.peaks.length; i++) m = Math.max(m, Math.abs(l.peaks[i])); l.silent = m < 0.02; }
  const G = { speed: 1, bass: false, compare: false, selected: lanes.find((l) => !l.silent)?.name || 'vocals', section: null, loop: false };
  const history = [];

  const snapshot = () => JSON.stringify({ G: { speed: G.speed, bass: G.bass }, lanes: lanes.map(({ name, vol, pan, mute, solo, pitch, scope, region, effect, inst }) => ({ name, vol, pan, mute, solo, pitch, scope, region, effect, inst })) });
  const pushHistory = () => { history.push(snapshot()); if (history.length > 60) history.shift(); renderTop(); };

  // ---------------------------------------------------------------- rendering of each part
  async function instBuffer(l) {
    const { name, octave, tidy } = l.inst;
    const key = `inst:${l.name}:${name}:${octave}:${tidy}`;
    if (renderCache.has(key)) return renderCache.get(key);
    if (!l.notes[tidy]) {
      l.status = 'Listening for the notes…'; renderLanes(); renderEditor();
      const m = mono(l.stem);
      l.notes[tidy] = await work('notes', { mono: m, sr: SR, lane: l.name, bpm: A.bpm, quantize: tidy, offset: A.downbeat }, { transfer: [m.buffer] });
    }
    l.status = `Playing ${l.notes[tidy].length} notes on ${INSTRUMENTS[name].label.toLowerCase()}…`; renderLanes(); renderEditor();
    const chs = await work('render', { notes: l.notes[tidy], instrument: name, sr: SR, length: l.stem.length, octave });
    return cacheSet(key, makeBuffer(chs));
  }

  async function finalOf(l, base, baseKey) {
    if (!l.pitch) return base;
    const region = l.scope === 'section' && l.region ? l.region : null;
    const key = `${baseKey}|p${l.pitch}|${region ? `${region.start.toFixed(2)}-${region.end.toFixed(2)}` : 'all'}`;
    if (renderCache.has(key)) return renderCache.get(key);
    const out = await transformBuffer(base, { semitones: l.pitch, region }, (p) => { l.status = `Fine-tuning the pitch… ${Math.round(p * 100)}%`; renderLaneStatus(l); });
    return cacheSet(key, out);
  }

  async function rebuild(l) {
    const ver = ++l.ver;
    try {
      const bases = [];
      if (!l.inst || l.inst.mode === 'layer') bases.push({ buf: l.stem, key: `stem:${l.name}` });
      if (l.inst) bases.push({ buf: await instBuffer(l), key: `inst:${l.name}:${l.inst.name}:${l.inst.octave}:${l.inst.tidy}` });
      if (ver !== l.ver || destroyed) return;
      // instant preview: real-time pitch on the unprocessed sound while the clean version renders
      const preview = l.pitch && l.scope === 'all';
      l.chain.setPitchPreview(preview ? l.pitch : 0);
      player.setParts(l.name, l.chain.input, bases.map((b) => ({ buffer: b.buf, at: 0 })));
      player.refreshLane(l.name);
      if (l.pitch) {
        l.status = l.scope === 'section' ? 'Changing the pitch of that part…' : 'Fine-tuning the pitch…';
        renderLaneStatus(l);
        const finals = [];
        for (const b of bases) finals.push(await finalOf(l, b.buf, b.key));
        if (ver !== l.ver || destroyed) return;
        l.chain.setPitchPreview(0);
        player.setParts(l.name, l.chain.input, finals.map((buf) => ({ buffer: buf, at: 0 })));
        player.refreshLane(l.name);
      }
      l.status = '';
    } catch (e) {
      if (ver === l.ver) { l.status = ''; shell.toast(`${l.label}: ${e.message}`, true); }
    }
    renderLanes(); renderEditor();
  }

  function applyMix() {
    const anySolo = lanes.some((l) => l.solo);
    const t = ctx.currentTime;
    for (const l of lanes) {
      const on = !G.compare && !l.mute && (!anySolo || l.solo);
      l.chain.mute.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
      l.chain.volume.gain.setTargetAtTime(l.vol, t, 0.015);
      l.chain.pan.pan.setTargetAtTime(l.pan, t, 0.015);
    }
    origChain.gain.setTargetAtTime(G.compare ? 1 : 0, t, 0.015);
    master.bass.gain.setTargetAtTime(G.bass ? 9 : 0, t, 0.05);
  }

  /** Change a part's settings (used by the editor, recipes and undo). */
  function set(name, patch, { record = false } = {}) {
    const l = lanes.find((x) => x.name === name);
    if (!l) return;
    if (record) pushHistory();
    const needs = ['pitch', 'scope', 'region', 'inst'].some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(l[k]));
    Object.assign(l, patch);
    if ('effect' in patch) l.chain.setEffect(l.effect, A.bpm);
    applyMix();
    if (needs) rebuild(l);
    scheduleIdeas();
  }
  const setSpeed = (v) => { G.speed = v; player.setRate(v); scheduleIdeas(); };

  // ---------------------------------------------------------------- creative ideas (several can be on at once)
  const OFF = { mute: false, solo: false, effect: 'none', inst: null, pitch: 0 };
  const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  /** What an idea changes, without applying it. */
  function ideaPatches(r) {
    const out = { lanes: {}, speed: null };
    r.apply({ set: (n, p) => { out.lanes[n] = { ...(out.lanes[n] || {}), ...p }; }, speed: (v) => { out.speed = v; } });
    return out;
  }
  /** An idea is "on" when the song currently has every change it makes. */
  function ideaActive(r) {
    const p = ideaPatches(r);
    if (p.speed != null && Math.abs(G.speed - p.speed) > 1e-6) return false;
    for (const [n, patch] of Object.entries(p.lanes)) {
      const l = lanes.find((x) => x.name === n);
      for (const [k, v] of Object.entries(patch)) if (!sameJSON(l?.[k], v)) return false;
    }
    return true;
  }
  function applyIdea(r) {
    pushHistory();
    r.apply({ set: (n, p) => set(n, p), speed: (v) => setSpeed(v) });
    applyMix(); renderAll();
    shell.toast(`${r.name}: ${r.desc}`);
    if (!player.playing) toggle();
  }
  function removeIdea(r) {
    const others = RECIPES.filter((x) => x !== r && ideaActive(x)); // keep the other ideas that are on
    pushHistory();
    const p = ideaPatches(r);
    for (const [n, patch] of Object.entries(p.lanes)) { const off = {}; for (const k of Object.keys(patch)) off[k] = OFF[k]; set(n, off); }
    if (p.speed != null) setSpeed(1);
    for (const x of others) x.apply({ set: (n, pp) => set(n, pp), speed: (v) => setSpeed(v) });
    applyMix(); renderAll();
    shell.toast(`Removed “${r.name}”`);
  }
  let ideasQueued = false;
  function scheduleIdeas() { if (ideasQueued) return; ideasQueued = true; requestAnimationFrame(() => { ideasQueued = false; renderIdeas(); }); }
  function renderIdeas() {
    const box = el.querySelector('#stRecipes'); if (!box) return;
    const on = RECIPES.map(ideaActive), n = on.filter(Boolean).length;
    box.innerHTML = `<div class="rc-head"><div><h4>Creative ideas</h4><p>Tap to add, tap again to remove. You can combine several.</p></div>
      ${n ? `<span class="rc-count" title="Ideas that are on">✓ <b data-notr>${n}</b></span>` : ''}
      <button class="chip-btn accent" data-random>🎲 Random idea</button></div>
      <div class="rc-grid">${RECIPES.map((r, i) => `<button data-r="${i}" class="${on[i] ? 'on' : ''}" aria-pressed="${on[i]}">${on[i] ? '<i class="rc-on">✓ On</i>' : ''}<b>${esc(r.name)}</b><span>${esc(r.desc)}</span></button>`).join('')}</div>`;
  }

  function restore(json) {
    const s = JSON.parse(json);
    G.speed = s.G.speed; G.bass = s.G.bass; player.setRate(G.speed); scheduleIdeas();
    for (const ls of s.lanes) { const { name, ...rest } = ls; set(name, rest); }
    applyMix(); renderAll();
  }

  for (const l of lanes) { player.setParts(l.name, l.chain.input, [{ buffer: l.stem, at: 0 }]); l.chain.setEffect('none'); }
  applyMix();

  // ---------------------------------------------------------------- UI
  const sec = A.sections;
  el.innerHTML = `
    <div class="st-top">
      <div class="st-transport">
        <button class="cr-play" id="stPlay" title="Play / pause (Space)"><svg viewBox="0 0 24 24" class="i-play"><path d="M8 5v14l11-7z"/></svg><svg viewBox="0 0 24 24" class="i-pause"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg></button>
        <div class="st-time"><b id="stTime">0:00</b><span> / ${fmtTime(mix.duration)}</span></div>
        <div class="st-facts"><span title="Beats per minute">♩ ${Math.round(A.bpm)} BPM</span><span title="Musical key (Camelot ${A.key.camelot})">🔑 ${esc(A.key.name)}</span></div>
      </div>
      <div class="st-actions">
        <button class="chip-btn" id="stCompare" title="Hear the original song (hold or click)">⇄ Original</button>
        <button class="chip-btn" id="stUndo" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button class="chip-btn accent" id="stSurprise" title="Try a ready-made idea">🎲 Surprise me</button>
        <button class="chip-btn" id="stExport" title="Save your version as a WAV file">⬇ Save my version</button>
      </div>
    </div>
    <div class="st-global">
      <div class="seg" id="stSpeed">${SPEEDS.map((s) => `<button data-v="${s.v}">${s.label}</button>`).join('')}</div>
      <button class="chip-btn" id="stBass">🔊 Bass boost</button>
      <button class="chip-btn" id="stLoop" title="Repeat the selected part of the song">🔁 Loop selected part</button>
    </div>
    <div class="st-board">
      <div class="st-lanes-wrap">
        <div class="st-sections" id="stSections">
          ${sec.map((s, i) => `<button class="st-sec" data-i="${i}" style="left:${(s.start / mix.duration) * 100}%;width:${((s.end - s.start) / mix.duration) * 100}%;--c:${SECTION_COLORS[s.label] || '#7b5cff'}" title="${esc(s.label)} · ${fmtTime(s.start)}–${fmtTime(s.end)} (click to select, double-click to jump)">${esc(s.label)}</button>`).join('')}
        </div>
        <div class="st-lanes" id="stLanes"></div>
        <div class="st-playhead" id="stHead"></div>
      </div>
      <aside class="st-editor" id="stEditor"></aside>
    </div>
    <section class="st-recipes" id="stRecipes"></section>`;

  const $ = (s) => el.querySelector(s);
  const lanesEl = $('#stLanes');
  lanesEl.innerHTML = lanes.map((l) => `
    <div class="st-lane" data-lane="${l.name}" style="--c:${l.color}">
      <div class="st-lane-head">
        <span class="st-icon">${l.icon}</span>
        <span class="st-name"><b>${l.label}</b><small class="st-status"></small></span>
        <span class="st-meter"><i></i></span>
        <button class="mini" data-act="mute" title="Mute">M</button>
        <button class="mini" data-act="solo" title="Only this part">S</button>
      </div>
      <div class="st-wave"><canvas></canvas><span class="st-tags"></span></div>
    </div>`).join('');

  function drawLane(l) {
    const row = lanesEl.querySelector(`[data-lane="${l.name}"]`);
    const regions = G.section != null ? [{ x0: sec[G.section].start / mix.duration, x1: sec[G.section].end / mix.duration, color: 'rgba(255,255,255,.05)' }] : [];
    const bar = (4 * 60) / A.bpm, marks = [];
    for (let t = A.downbeat; t < mix.duration; t += bar * 4) marks.push(t / mix.duration);
    drawWave(row.querySelector('canvas'), l.peaks, { color: l.color, progress: 1, dim: l.silent, regions, marks });
  }
  function renderLaneStatus(l) {
    const row = lanesEl.querySelector(`[data-lane="${l.name}"]`);
    if (row) row.querySelector('.st-status').textContent = l.status || (l.silent ? 'barely used in this song' : '');
  }
  function renderLanes() {
    const anySolo = lanes.some((l) => l.solo);
    for (const l of lanes) {
      const row = lanesEl.querySelector(`[data-lane="${l.name}"]`);
      row.classList.toggle('selected', G.selected === l.name);
      row.classList.toggle('off', l.mute || (anySolo && !l.solo));
      row.classList.toggle('busy', !!l.status);
      row.querySelector('[data-act="mute"]').classList.toggle('on', l.mute);
      row.querySelector('[data-act="solo"]').classList.toggle('on', l.solo);
      const tags = [];
      if (l.inst) tags.push(`${INSTRUMENTS[l.inst.name].icon} ${INSTRUMENTS[l.inst.name].label}${l.inst.mode === 'layer' ? ' + original' : ''}`);
      if (l.pitch) tags.push(`${l.pitch > 0 ? '↑' : '↓'} ${Math.abs(l.pitch)} step${Math.abs(l.pitch) > 1 ? 's' : ''}${l.scope === 'section' ? ' (one part)' : ''}`);
      if (l.effect !== 'none') tags.push(`${EFFECTS[l.effect].icon} ${EFFECTS[l.effect].label}`);
      if (l.vol !== 1) tags.push(`🔉 ${Math.round(l.vol * 100)}%`);
      row.querySelector('.st-tags').innerHTML = tags.map((t) => `<em>${esc(t)}</em>`).join('');
      renderLaneStatus(l);
    }
  }
  const drawAll = () => lanes.forEach(drawLane);

  function renderEditor() {
    const l = lanes.find((x) => x.name === G.selected);
    const secSel = G.section != null ? sec[G.section] : null;
    $('#stEditor').style.setProperty('--c', l.color);
    $('#stEditor').innerHTML = `
      <div class="ed-head"><span class="st-icon big">${l.icon}</span><div><h3>${l.label}</h3><p>${l.silent ? 'This part is very quiet in this song.' : 'Click below to change how it sounds.'}</p></div></div>
      ${l.status ? `<div class="ed-status"><span class="spinner"></span>${esc(l.status)}</div>` : ''}
      <section><h4>Loudness</h4>
        <label class="ed-row">🔉<input type="range" min="0" max="150" value="${Math.round(l.vol * 100)}" data-k="vol"><span>${Math.round(l.vol * 100)}%</span></label>
        <label class="ed-row">◀<input type="range" min="-100" max="100" value="${Math.round(l.pan * 100)}" data-k="pan"><span>▶</span></label>
      </section>
      <section><h4>Pitch <small>higher or lower, same speed</small></h4>
        <div class="ed-stepper"><button data-pitch="-1">− Lower</button><b>${l.pitch === 0 ? 'Original' : `${l.pitch > 0 ? '+' : ''}${l.pitch}`}</b><button data-pitch="1">Higher +</button></div>
        <div class="seg small" data-k="scope"><button data-v="all" class="${l.scope === 'all' ? 'on' : ''}">Whole song</button><button data-v="section" class="${l.scope === 'section' ? 'on' : ''}" ${secSel ? '' : 'disabled title="Select a part of the song above first"'}>${secSel ? `Only the ${esc(secSel.label)}` : 'Only a part'}</button></div>
      </section>
      <section><h4>Instrument <small>play this part's melody on something else</small></h4>
        <div class="ed-grid">
          <button class="inst ${!l.inst ? 'on' : ''}" data-inst="">${l.icon}<span>Original</span></button>
          ${Object.entries(INSTRUMENTS).map(([k, v]) => `<button class="inst ${l.inst?.name === k ? 'on' : ''}" data-inst="${k}">${v.icon}<span>${v.label}</span></button>`).join('')}
        </div>
        ${l.inst ? `
          <div class="seg small" data-k="mode"><button data-v="replace" class="${l.inst.mode === 'replace' ? 'on' : ''}">Replace original</button><button data-v="layer" class="${l.inst.mode === 'layer' ? 'on' : ''}">Play together</button></div>
          <div class="ed-inline"><span>Octave</span><button data-oct="-1">−</button><b>${l.inst.octave > 0 ? '+' : ''}${l.inst.octave}</b><button data-oct="1">+</button>
          <label class="tog"><input type="checkbox" data-k="tidy" ${l.inst.tidy ? 'checked' : ''}> Tidy timing</label></div>
          <p class="cr-hint">Works best on single-note lines (bass, leads, cowbells). Big chords come out simpler.</p>` : ''}
      </section>
      <section><h4>Sound effect</h4>
        <div class="ed-grid fx">${Object.entries(EFFECTS).map(([k, v]) => `<button class="inst ${l.effect === k ? 'on' : ''}" data-fx="${k}">${v.icon}<span>${v.label}</span></button>`).join('')}</div>
      </section>
      <div class="ed-foot"><button class="chip-btn" data-act="reset">Reset this part</button><button class="chip-btn" data-act="save">⬇ Save this part</button></div>`;
  }

  function renderTop() {
    $('#stPlay').classList.toggle('playing', player.playing);
    $('#stCompare').classList.toggle('on', G.compare);
    $('#stBass').classList.toggle('on', G.bass);
    $('#stLoop').classList.toggle('on', !!G.loop);
    $('#stLoop').disabled = G.section == null;
    $('#stUndo').disabled = !history.length;
    el.querySelectorAll('#stSpeed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === G.speed));
    el.querySelectorAll('.st-sec').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === G.section));
  }
  function renderAll() { renderTop(); renderLanes(); renderEditor(); drawAll(); }

  // ---------------------------------------------------------------- events
  const toggle = () => { if (player.playing) player.pause(); else { audio(); player.play(); } renderTop(); };
  $('#stPlay').onclick = toggle;
  $('#stCompare').onclick = () => { G.compare = !G.compare; applyMix(); renderTop(); };
  $('#stBass').onclick = () => { pushHistory(); G.bass = !G.bass; applyMix(); renderTop(); };
  $('#stUndo').onclick = () => { const s = history.pop(); if (s) restore(s); };
  $('#stSpeed').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; pushHistory(); setSpeed(Number(b.dataset.v)); renderTop(); };
  $('#stLoop').onclick = () => {
    if (G.section == null) return;
    G.loop = !G.loop;
    player.setLoop(G.loop ? { start: sec[G.section].start, end: sec[G.section].end } : null);
    renderTop();
  };
  $('#stSections').onclick = (e) => {
    const b = e.target.closest('.st-sec'); if (!b) return;
    const i = Number(b.dataset.i);
    G.section = G.section === i ? null : i;
    if (G.loop) player.setLoop(G.section != null ? { start: sec[G.section].start, end: sec[G.section].end } : null);
    if (G.section == null) G.loop = false;
    renderTop(); drawAll(); renderEditor();
  };
  $('#stSections').ondblclick = (e) => { const b = e.target.closest('.st-sec'); if (b) { player.seek(sec[Number(b.dataset.i)].start); if (!player.playing) toggle(); } };

  lanesEl.onclick = (e) => {
    const row = e.target.closest('.st-lane'); if (!row) return;
    const l = lanes.find((x) => x.name === row.dataset.lane);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mute') { pushHistory(); set(l.name, { mute: !l.mute }); }
    else if (act === 'solo') { pushHistory(); set(l.name, { solo: !l.solo }); }
    else if (e.target.closest('.st-wave')) {
      const r = e.target.closest('.st-wave').getBoundingClientRect();
      player.seek(((e.clientX - r.left) / r.width) * mix.duration);
    }
    G.selected = l.name;
    renderLanes(); renderEditor();
  };

  const ed = $('#stEditor');
  ed.oninput = (e) => {
    const k = e.target.dataset.k, l = lanes.find((x) => x.name === G.selected);
    if (k === 'vol') { set(l.name, { vol: e.target.value / 100 }); e.target.nextElementSibling.textContent = `${e.target.value}%`; renderLanes(); }
    if (k === 'pan') set(l.name, { pan: e.target.value / 100 });
  };
  ed.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') pushHistory(); });
  ed.onchange = (e) => {
    const l = lanes.find((x) => x.name === G.selected);
    if (e.target.dataset.k === 'tidy') { pushHistory(); set(l.name, { inst: { ...l.inst, tidy: e.target.checked } }); renderLanes(); renderEditor(); }
  };
  ed.onclick = (e) => {
    const l = lanes.find((x) => x.name === G.selected);
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const segK = b.parentElement.dataset.k;
    if (b.dataset.pitch) { pushHistory(); const p = Math.max(-12, Math.min(12, l.pitch + Number(b.dataset.pitch))); set(l.name, { pitch: p, region: l.scope === 'section' && G.section != null ? { start: sec[G.section].start, end: sec[G.section].end } : null }); }
    else if (segK === 'scope') { pushHistory(); const scope = b.dataset.v; set(l.name, { scope, region: scope === 'section' ? { start: sec[G.section].start, end: sec[G.section].end } : null }); }
    else if ('inst' in b.dataset) { pushHistory(); set(l.name, { inst: b.dataset.inst ? { name: b.dataset.inst, octave: l.inst?.octave ?? (l.name === 'bass' && b.dataset.inst !== 'bass808' ? 1 : 0), mode: l.inst?.mode || 'replace', tidy: l.inst?.tidy ?? true } : null }); }
    else if (segK === 'mode') { pushHistory(); set(l.name, { inst: { ...l.inst, mode: b.dataset.v } }); }
    else if (b.dataset.oct) { pushHistory(); set(l.name, { inst: { ...l.inst, octave: Math.max(-2, Math.min(2, l.inst.octave + Number(b.dataset.oct))) } }); }
    else if (b.dataset.fx) { pushHistory(); set(l.name, { effect: b.dataset.fx }); }
    else if (b.dataset.act === 'reset') { pushHistory(); set(l.name, { vol: 1, pan: 0, mute: false, solo: false, pitch: 0, scope: 'all', region: null, effect: 'none', inst: null }); }
    else if (b.dataset.act === 'save') { saveLane(l); return; }
    renderLanes(); renderEditor();
  };

  // "Surprise me" takes you down to the ideas
  $('#stSurprise').onclick = () => {
    const box = $('#stRecipes');
    renderIdeas();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse');
    setTimeout(() => box.querySelector('[data-r]')?.focus({ preventScroll: true }), 600);
  };
  $('#stRecipes').onclick = (e) => {
    if (e.target.closest('[data-random]')) {
      const off = RECIPES.filter((r) => !ideaActive(r));
      if (off.length) applyIdea(off[Math.floor(Math.random() * off.length)]);
      return;
    }
    const b = e.target.closest('[data-r]'); if (!b) return;
    const r = RECIPES[Number(b.dataset.r)];
    if (ideaActive(r)) removeIdea(r); else applyIdea(r);
  };
  renderIdeas();

  async function saveLane(l) {
    shell.toast(`Saving ${l.label}…`);
    const parts = player.lanes.get(l.name).parts;
    const len = Math.max(...parts.map((p) => p.buffer.length));
    const off = new OfflineAudioContext(2, len, SR);
    await ensureWorklet(off);
    const ch = makeChain(off, off.destination);
    ch.setEffect(l.effect, A.bpm); ch.setPitchPreview(l.chain.pitch.parameters.get('semitones').value); ch.volume.gain.value = l.vol; ch.pan.pan.value = l.pan;
    for (const p of parts) { const s = off.createBufferSource(); s.buffer = p.buffer; s.connect(ch.input); s.start(0); }
    const out = await off.startRendering(), name = `${track.title} - ${l.label} (Mixtape)`;
    const blob = encodeWav(out);
    download(blob, `${name}.wav`);
    saveInspiration(blob, { kind: 'studio', title: name, track, durationSec: out.duration }, shell.toast);
  }

  $('#stExport').onclick = async () => {
    const btn = $('#stExport'); btn.disabled = true; btn.textContent = '⏳ Saving…';
    try {
      const len = Math.ceil((mix.length) / G.speed);
      const off = new OfflineAudioContext(2, len, SR);
      await ensureWorklet(off);
      const m = (() => { const b = off.createBiquadFilter(); b.type = 'lowshelf'; b.frequency.value = 120; b.gain.value = G.bass ? 9 : 0; const c = off.createDynamicsCompressor(); c.threshold.value = -3; c.ratio.value = 12; b.connect(c).connect(off.destination); return b; })();
      const anySolo = lanes.some((l) => l.solo);
      for (const l of lanes) {
        if (l.mute || (anySolo && !l.solo)) continue;
        const ch = makeChain(off, m);
        ch.setEffect(l.effect, A.bpm); ch.setPitchPreview(l.chain.pitch.parameters.get('semitones').value);
        ch.volume.gain.value = l.vol; ch.pan.pan.value = l.pan;
        for (const p of player.lanes.get(l.name).parts) { const s = off.createBufferSource(); s.buffer = p.buffer; s.playbackRate.value = G.speed; s.connect(ch.input); s.start(0); }
      }
      const out = await off.startRendering(), blob = encodeWav(out);
      download(blob, `${track.title} (Mixtape remix).wav`);
      shell.toast('Saved your version');
      saveInspiration(blob, { kind: 'studio', title: `${track.title} (my remix)`, track, durationSec: out.duration }, shell.toast);
    } catch (e) { shell.toast(e.message, true); }
    btn.disabled = false; btn.textContent = '⬇ Save my version';
  };

  const onKey = (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('#stUndo').click(); }
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(drawAll); ro.observe(lanesEl);

  // animation: playhead, time, meters
  let raf;
  const tick = () => {
    const t = player.time();
    if (player.playing && t >= mix.duration - 0.02 && !player.loop) { player.pause(); player.seek(0); renderTop(); }
    const lw = lanesEl.querySelector('.st-wave');
    if (lw) {
      const r = lw.getBoundingClientRect(), pr = lanesEl.parentElement.getBoundingClientRect();
      $('#stHead').style.left = `${r.left - pr.left + (t / mix.duration) * r.width}px`;
    }
    $('#stTime').textContent = fmtTime(t);
    for (const l of lanes) {
      const v = player.playing ? Math.min(1, l.chain.level() * 4) : 0;
      lanesEl.querySelector(`[data-lane="${l.name}"] .st-meter i`).style.height = `${v * 100}%`;
    }
    raf = requestAnimationFrame(tick);
  };
  renderAll();
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('keydown', onKey);
      player.pause();
      lanes.forEach((l) => l.chain.disconnect()); origChain.disconnect();
    },
    info: { track, analysis: A },
  };
}
