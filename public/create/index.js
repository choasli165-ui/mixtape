// Creation Mode shell: tabs (Studio / Mashup / DJ / Sing), "Start Creating" overlay, one-time AI setup, song picker.
import { engineStatus, installEngine, audio } from './core.js';
import { t } from '/i18n.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TABS = [
  { id: 'studio', label: 'Studio', icon: '🎚️', desc: 'See the parts of a song and change them', needsAI: true },
  { id: 'mashup', label: 'Mashup', icon: '🧬', desc: 'Combine parts of two songs', needsAI: true },
  { id: 'dj', label: 'DJ', icon: '🎧', desc: 'Mix songs live with two decks', needsAI: false },
  { id: 'sing', label: 'Sing', icon: '🎤', desc: 'Sing along with live pitch correction', needsAI: true },
];

let current = null; // { tab, view, track }

/**
 * Mount Creation Mode into `root`.
 * host: { track, toast(msg, err), pausePlayer(), libraryTracks(): Promise<track[]>, search(q): Promise<track[]> }
 */
const INTRO = {
  studio: { title: 'Studio', text: 'Split the song into vocals, drums, bass, guitar, piano and other sounds, then change any part.', note: 'The song is split on your PC. The first time takes from about 15 seconds to a few minutes; after that it opens instantly.' },
  mashup: { title: 'Mashup', text: 'Combine parts of this song with parts of another one. Tempo and key are matched automatically.', note: 'This song is split into its parts first (once per song).' },
  dj: { title: 'DJ', text: 'Two turntables, a mixer, pads and effects. This song goes on deck A.', note: 'Only the song itself is loaded. No splitting needed.' },
  sing: { title: 'Sing', text: 'Sing along with live pitch correction. The original singer is separated from the music first.', note: 'The song is split on your PC (once per song), then your microphone is used.' },
};
const started = new Set(); // "tab|trackId" pairs already started in this session: open them straight away (data is cached)

/**
 * Mount Creation Mode into `root`. Opening is instant: nothing is loaded or processed until the user presses
 * "Start Creating" for a tab, and each tab only loads what it needs.
 * host: { track, toast(msg, err), pausePlayer(), libraryTracks(): Promise<track[]>, search(q): Promise<track[]> }
 */
export async function openCreation(root, host, { tab = current?.tab || 'studio', track = host.track, start = false } = {}) {
  await closeCreation();
  const token = Symbol('creation');
  host.onTab?.(tab);
  current = { tab, track, root, host, view: null, token };
  root.innerHTML = `
    <div class="cr">
      <header class="cr-head">
        <div class="cr-title"><span class="eyebrow">${tab === 'sing' ? 'Sing Mode' : 'Creation Mode'}</span>
          <h1 ${track ? 'data-notr' : ''}>${track ? esc(track.title) : 'Pick a song to start'}</h1>
          ${track ? `<p><span data-notr>${esc(track.artist)}</span> <button class="link" id="crChange">change song</button></p>` : ''}</div>
        <nav class="cr-tabs">${TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === tab ? 'on' : ''}" title="${esc(t.desc)}"><span>${t.icon}</span><span>${t.label}</span></button>`).join('')}</nav>
      </header>
      <div class="cr-body" id="crBody"></div>
    </div>
    <div class="cr-modal hidden" id="crPicker"></div>`;
  // switching tabs never starts work by itself; the selected song comes along
  root.querySelector('.cr-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== tab) openCreation(root, host, { tab: b.dataset.tab, track: current.track }); };
  root.querySelector('#crChange')?.addEventListener('click', async () => {
    const t = await pickTrack(tab === 'sing' ? 'Choose a song to sing' : 'Choose a song to create with');
    if (t) openCreation(root, { ...host, track: t }, { tab, track: t });
  });
  const body = root.querySelector('#crBody');
  const spec = TABS.find((t) => t.id === tab);

  if (!track && tab !== 'dj') {
    body.innerHTML = `<div class="cr-empty"><h3>Choose a song</h3><p>${tab === 'sing' ? 'Pick any song from your library or SoundCloud to sing along to.' : 'Creation Mode works on any song from your library or SoundCloud.'}</p><button class="primary" id="crPick">Choose a song</button></div>`;
    body.querySelector('#crPick').onclick = async () => { const t = await pickTrack('Choose a song to create with'); if (t) openCreation(root, { ...host, track: t }, { tab, track: t }); };
    return;
  }

  const key = `${tab}|${track?.id || ''}`;
  if (start || started.has(key) || (tab === 'dj' && !track)) return run(track); // empty DJ decks load nothing heavy
  showIntro();

  // ---------------------------------------------------------------- "Start Creating" overlay (nothing loaded yet)
  function showIntro() {
    const it = INTRO[tab];
    body.innerHTML = `<div class="cr-intro">
      <div class="cr-intro-card">
        <div class="cr-intro-icon">${spec.icon}</div>
        <h2>${esc(it.title)}</h2>
        <p>${esc(it.text)}</p>
        ${track ? `<div class="cr-intro-song">${track.artwork ? `<img src="${esc(track.artwork)}" alt="" onerror="this.remove()">` : '<span class="mx-noart"></span>'}<span data-notr><b>${esc(track.title)}</b><small>${esc(track.local ? t('You') : track.artist)}</small></span></div>` : ''}
        <button class="primary cr-start" id="crStart">${track ? 'Start Creating' : 'Open the decks'}</button>
        ${tab === 'dj' && track ? '<button class="link" id="crEmpty">Open empty decks instead</button>' : ''}
        <p class="cr-hint" id="crIntroNote">${esc(it.note)}</p>
      </div></div>`;
    body.querySelector('#crStart').onclick = () => run(track);
    body.querySelector('#crEmpty')?.addEventListener('click', () => run(null));
    // cheap check (no audio loaded): is this song already split?
    if (spec.needsAI && track) fetch(`/api/create/stems/${encodeURIComponent(track.id)}`).then((r) => r.json()).then((st) => {
      const n = body.querySelector('#crIntroNote');
      if (st.ready && n && current?.token === token) n.textContent = 'This song is already split, so it opens instantly.';
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- the actual work, only after the user asks
  async function run(t) {
    audio(); // create the AudioContext on this user gesture
    host.pausePlayer?.();
    started.add(`${tab}|${t?.id || ''}`);
    const shell = { track: t, toast: host.toast, pickTrack };
    body.innerHTML = '<div class="cr-loading"><div class="spinner big"></div></div>';
    if (spec.needsAI) {
      const st = await engineStatus().catch(() => ({ ready: false }));
      if (current?.token !== token) return;
      if (!st.ready) return showSetup(body, () => openCreation(root, host, { tab, track, start: true }), st);
    }
    try {
      const mod = tab === 'studio' ? await import('./studio.js') : tab === 'mashup' ? await import('./mashup.js') : tab === 'sing' ? await import('./sing.js') : await import('./dj.js');
      if (current?.token !== token) return;
      const fn = mod.createStudio || mod.createMashup || mod.createSing || mod.createDJ;
      const view = await fn(body, shell);
      if (current?.token === token) current.view = view; else view?.destroy?.();
    } catch (e) {
      console.error(e);
      started.delete(`${tab}|${t?.id || ''}`);
      if (current?.token !== token) return;
      const gpu = /887A00|DirectML|dml|GPU device/i.test(e.message);
      body.innerHTML = `<div class="cr-empty"><h3>Something went wrong</h3>
        <p>${gpu ? 'Your graphics card stopped responding while splitting the song. Mixtape will use the processor for now. Press Try again.' : esc(e.message)}</p>
        ${gpu ? `<details><summary>Technical details</summary><p class="cr-err">${esc(e.message)}</p></details>` : ''}
        <button class="primary" id="crRetry">Try again</button></div>`;
      body.querySelector('#crRetry').onclick = () => openCreation(root, host, { tab, track, start: true });
    }
  }

  // ---------------------------------------------------------------- song picker
  function pickTrack(title) {
    const modal = root.querySelector('#crPicker');
    return new Promise((resolve) => {
      let tracks = [];
      const close = (v) => { modal.classList.add('hidden'); modal.innerHTML = ''; resolve(v); };
      modal.innerHTML = `<div class="cr-sheet"><div class="cr-sheet-head"><h3>${esc(title)}</h3><button class="icon" data-close>✕</button></div>
        <input class="cr-search" placeholder="Search your songs or SoundCloud…" autofocus>
        <div class="cr-list"><p class="cr-hint">Loading your library…</p></div></div>`;
      modal.classList.remove('hidden');
      const list = modal.querySelector('.cr-list'), input = modal.querySelector('input');
      const show = (arr, note = '') => {
        list.innerHTML = (note ? `<p class="cr-hint">${esc(note)}</p>` : '') + (arr.length ? arr.map((t, i) => `<button class="cr-item" data-i="${i}">${t.artwork ? `<img src="${esc(t.artwork)}" alt="">` : '<span class="mx-noart"></span>'}<span data-notr><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span></button>`).join('') : '<p class="cr-hint">Nothing found.</p>');
        list._arr = arr;
      };
      host.libraryTracks().then((t) => { tracks = t; show(tracks); });
      let timer;
      input.oninput = () => {
        clearTimeout(timer);
        const q = input.value.trim().toLowerCase();
        const local = tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
        show(local, q ? 'From your library' : '');
        if (q.length > 2) timer = setTimeout(async () => {
          const web = await host.search(input.value.trim()).catch(() => []);
          const ids = new Set(local.map((t) => t.id));
          show([...local, ...web.filter((t) => !ids.has(t.id))], local.length ? 'Your library first, then SoundCloud' : 'From SoundCloud');
        }, 350);
      };
      modal.onclick = (e) => {
        if (e.target === modal || e.target.closest('[data-close]')) return close(null);
        const b = e.target.closest('.cr-item'); if (b) close(list._arr[Number(b.dataset.i)]);
      };
    });
  }
}

function showSetup(body, done, st = {}) {
  body.innerHTML = `
    <div class="cr-setup">
      <div class="cr-setup-art">🎚️</div>
      <h2>One-time setup: the song-splitting AI</h2>
      <p>To see and edit the parts of a song (vocals, drums, bass, guitar, piano and other sounds), Mixtape uses Demucs, a free, open-source AI by Meta (MIT licence). It runs entirely on your PC. Your music is never uploaded.</p>
      <ul><li>Download: about 200 MB, only once</li><li>Uses your graphics card when it can (much faster), otherwise the processor</li><li>Each song is split once (≈15 s–1 min), then it's instant</li></ul>
      <button class="primary" id="crInstall">Download and set up</button>
      <div class="cr-bar hidden" id="crInstBar"><i></i></div><p class="cr-hint" id="crInstText"></p>
      <p class="cr-hint">The DJ tab works without this download.</p>
      <details class="cr-manual"><summary>No internet on this PC?</summary>
        <p>Copy the model file <code data-notr>${esc(st.modelFile || 'htdemucs_6s_fp16weights.onnx')}</code> into this folder, then reopen Creation Mode:</p>
        <p><code data-notr>${esc(st.modelFolder || '')}</code></p>
        <p>The Mixtape installer already includes everything when it was built with the AI bundled.</p></details>
    </div>`;
  body.querySelector('#crInstall').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Downloading…';
    const bar = body.querySelector('#crInstBar'); bar.classList.remove('hidden');
    try {
      await installEngine((p) => {
        bar.querySelector('i').style.width = `${p.pct}%`;
        body.querySelector('#crInstText').textContent = `${p.label}: ${p.pct}%${p.total ? ` of ${Math.round(p.total / 1e6)} MB` : ''}`;
      });
      done();
    } catch (err) {
      e.target.disabled = false; e.target.textContent = 'Try again';
      body.querySelector('#crInstText').textContent = `Download failed: ${err.message}. Check your internet connection (or proxy) and try again.`;
    }
  };
}

export async function closeCreation() {
  if (!current) return;
  const c = current; current = null;
  try { c.view?.destroy?.(); } catch (e) { console.error(e); }
}

export const isCreationOpen = () => !!current;
export const currentTab = () => current?.tab || null;
