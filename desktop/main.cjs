// Mixtape desktop shell (Electron). Hosts the Mixtape server in-process and shows the player in a native window.
const { app, BrowserWindow, Tray, Menu, net, nativeImage, shell, session, nativeTheme } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icon.png');
const PORT = Number(process.env.MIXTAPE_PORT) || 4321;
const TITLEBAR_H = 36;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.setAppUserModelId('com.mixtape.player');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
process.env.MIXTAPE_NO_BROWSER = '1';
// Claude Code's native installer puts claude.exe here; make sure the CLI provider can find it.
process.env.PATH = [path.join(os.homedir(), '.local', 'bin'), process.env.PATH].join(path.delimiter);

let win = null, tray = null, base = null, quitting = false;

// Server-side requests go through Chromium's network stack, so the system proxy (e.g. Clash) applies.
function useChromiumFetch() {
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return net.fetch(url, init);
  };
}

// Child processes (the Claude CLI) don't see the system proxy; hand it over via env vars.
async function exportSystemProxy() {
  if (process.env.HTTPS_PROXY) return;
  try {
    const p = await session.defaultSession.resolveProxy('https://api.anthropic.com');
    const m = /^(?:PROXY|HTTPS)\s+([^\s;]+)/i.exec(p);
    if (m) {
      process.env.HTTPS_PROXY = process.env.HTTP_PROXY = `http://${m[1]}`;
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
    }
  } catch { /* direct connection */ }
}

async function probe(url) {
  try {
    const r = await net.fetch(url + '/api/health', { signal: AbortSignal.timeout(1200) });
    return (await r.json()).app === 'mixtape-agent';
  } catch { return false; }
}

async function startBackend() {
  const existing = `http://127.0.0.1:${PORT}`;
  if (await probe(existing)) return existing; // reuse a player started elsewhere (e.g. by Claude via MCP)
  const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
  const [{ App }, { createServer, listen }, { ensureDefaults }] = await Promise.all([imp('src/app.js'), imp('src/server.js'), imp('src/seed.js')]);
  const mixtape = new App();
  const server = createServer(mixtape);
  let url;
  try { url = await listen(server, { host: '127.0.0.1', port: PORT }); }
  catch { url = await listen(server, { host: '127.0.0.1', port: 0 }); }
  ensureDefaults(mixtape, (m) => console.log('[mixtape]', m));
  return url;
}

function command(action, value) {
  if (!base) return;
  net.fetch(base + '/api/player/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, value }) }).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 880, minHeight: 600,
    title: 'Mixtape', icon: ICON, backgroundColor: '#121010', autoHideMenuBar: true, show: false,
    // No grey Windows title bar: the page fills the window; native min/max/close are drawn over it in app colours.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121010', symbolColor: '#a3988f', height: TITLEBAR_H },
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // keep playing in the tray
  // The top strip of the page becomes the window's drag handle (double-click maximises, like a title bar).
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS(`
    body::before { content: ''; position: fixed; top: 0; left: 0; right: 140px; height: ${TITLEBAR_H}px; -webkit-app-region: drag; z-index: 50; }
    .sidebar { padding-top: ${TITLEBAR_H}px !important; }
    .main { padding-top: 8px; }
    dialog, .toast { -webkit-app-region: no-drag; }
  `));
  win.loadURL(base);
}

function show() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

const TRAY = {
  en: ['Show Mixtape', 'Play / Pause', 'Next', 'Previous', 'Quit'],
  zh: ['显示 Mixtape', '播放 / 暂停', '下一首', '上一首', '退出'],
  ja: ['Mixtape を表示', '再生 / 一時停止', '次の曲', '前の曲', '終了'],
};
function trayLabels() {
  let lang = '';
  try { lang = JSON.parse(require('node:fs').readFileSync(path.join(process.env.MIXTAPE_HOME || path.join(os.homedir(), '.mixtape-agent'), 'config.json'), 'utf8')).ui?.language || ''; } catch {}
  if (!TRAY[lang]) { const l = app.getLocale().toLowerCase(); lang = l.startsWith('zh') ? 'zh' : l.startsWith('ja') ? 'ja' : 'en'; }
  return TRAY[lang];
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Mixtape');
  const buildMenu = () => {
    const [showL, playL, nextL, prevL, quitL] = trayLabels();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: showL, click: show },
      { type: 'separator' },
      { label: playL, click: () => command('toggle') },
      { label: nextL, click: () => command('next') },
      { label: prevL, click: () => command('previous') },
      { type: 'separator' },
      { label: quitL, click: () => { quitting = true; app.quit(); } },
    ]));
  };
  buildMenu();
  tray.on('right-click', buildMenu); // pick up a language change made in Settings
  tray.on('click', show);
}

app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in tray */ });

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'; // dark scrollbars, menus and window controls
  useChromiumFetch();
  await exportSystemProxy();
  try {
    base = await startBackend();
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Mixtape could not start', String(e && e.stack || e));
    app.quit();
    return;
  }
  createTray();
  createWindow();
});
