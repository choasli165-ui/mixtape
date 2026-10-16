// Builds and installs the Mixtape desktop app on Windows (run with: node desktop/build-desktop.mjs).
// 1. Downloads Electron into desktop/.build   2. Assembles %LOCALAPPDATA%\Programs\Mixtape\Mixtape.exe
// 3. Sets the exe icon   4. Creates Desktop + Start Menu shortcuts.  Falls back to an app-window shortcut on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ELECTRON_VERSION = '44.8.0';
const RCEDIT_VERSION = '4.0.1';
const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DESKTOP, '..');
const WORK = path.join(DESKTOP, '.build');
const TARGET = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Mixtape');
const LEGAL_FILES = ['LICENSE', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md'];
const RUNTIME_FILES = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];
const PRIVATE_NAMES = new Set(['my-songs.json', 'config.json', 'soundcloud-client-id.json', 'library.json', '.mixtape-agent', '.git', 'node_modules', 'secrets', 'logs', 'cache']);
const APP_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.css', '.html', '.svg', '.png', '.ico', '.webp', '.woff', '.woff2']);
const log = (...a) => console.log('[build]', ...a);

function run(cmd, args, opts = {}) {
  log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${r.status})`);
}

function installElectron() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'mixtape-build', private: true }));
  const env = { ...process.env, ELECTRON_GET_USE_PROXY: '1' };
  if (env.HTTPS_PROXY) { env.GLOBAL_AGENT_HTTPS_PROXY = env.HTTPS_PROXY; env.npm_config_proxy = env.HTTPS_PROXY; env.npm_config_https_proxy = env.HTTPS_PROXY; }
  const pkgs = [`electron@${ELECTRON_VERSION}`, `rcedit@${RCEDIT_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'];
  try { run('npm', ['install', ...pkgs], { cwd: WORK, env }); }
  catch (e) {
    log('Direct download failed; retrying with the npmmirror Electron mirror…');
    run('npm', ['install', ...pkgs], { cwd: WORK, env: { ...env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' } });
  }
  const dist = path.join(WORK, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) throw new Error('electron.exe missing after install');
  return dist;
}

function includeAppFile(source) {
  const name = path.basename(source);
  const stat = fs.lstatSync(source);
  return !name.startsWith('.') && !PRIVATE_NAMES.has(name.toLowerCase()) && !stat.isSymbolicLink()
    && (stat.isDirectory() || APP_EXTENSIONS.has(path.extname(name).toLowerCase()));
}

function assemble(dist) {
  // Stop a running copy so files can be replaced.
  spawnSync('taskkill', ['/IM', 'Mixtape.exe', '/F'], { stdio: 'ignore', shell: true });
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });
  fs.copyFileSync(path.join(dist, 'electron.exe'), path.join(TARGET, 'Mixtape.exe'));
  for (const f of RUNTIME_FILES) {
    if (fs.existsSync(path.join(dist, f))) fs.copyFileSync(path.join(dist, f), path.join(TARGET, f));
  }
  for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
    if (!fs.existsSync(path.join(TARGET, f))) throw new Error(`Electron runtime is missing its required ${f}`);
  }
  const locales = path.join(dist, 'locales');
  if (fs.existsSync(locales)) {
    fs.mkdirSync(path.join(TARGET, 'locales'), { recursive: true });
    for (const f of fs.readdirSync(locales)) {
      if (f.endsWith('.pak') && fs.statSync(path.join(locales, f)).isFile()) fs.copyFileSync(path.join(locales, f), path.join(TARGET, 'locales', f));
    }
  }
  fs.rmSync(path.join(TARGET, 'resources', 'default_app.asar'), { force: true });
  const appDir = path.join(TARGET, 'resources', 'app');
  // Reconstruct the app from source, even if the runtime cache contains an old app.
  fs.rmSync(appDir, { recursive: true, force: true });
  for (const d of ['bin', 'src', 'public']) fs.cpSync(path.join(ROOT, d), path.join(appDir, d), { recursive: true, filter: includeAppFile });
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'my-songs.example.json'), path.join(appDir, 'data', 'my-songs.example.json'));
  fs.mkdirSync(path.join(appDir, 'desktop'), { recursive: true });
  for (const f of ['main.cjs', 'icon.png', 'icon.ico', 'tray.png']) fs.copyFileSync(path.join(DESKTOP, f), path.join(appDir, 'desktop', f));
  for (const f of LEGAL_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
  fs.mkdirSync(path.join(appDir, 'THIRD_PARTY'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'installer', 'THIRD_PARTY', 'Go-LICENSE.txt'), path.join(appDir, 'THIRD_PARTY', 'Go-LICENSE.txt'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'mixtape', productName: 'Mixtape', version: pkg.version, type: 'module', main: 'desktop/main.cjs',
  }, null, 2));
  fs.copyFileSync(path.join(DESKTOP, 'icon.ico'), path.join(TARGET, 'Mixtape.ico'));
}

function setExeIcon() {
  const dir = path.join(WORK, 'node_modules', 'rcedit', 'bin');
  const exe = ['rcedit-x64.exe', 'rcedit.exe'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!exe) return log('rcedit not found; skipping exe icon');
  try {
    run(`"${exe}"`, [`"${path.join(TARGET, 'Mixtape.exe')}"`, '--set-icon', `"${path.join(TARGET, 'Mixtape.ico')}"`,
      '--set-version-string', 'ProductName', 'Mixtape', '--set-version-string', 'FileDescription', 'Mixtape', '--set-version-string', 'CompanyName', 'Mixtape']);
  } catch (e) { log('Icon step failed (non-fatal):', e.message); }
}

function shortcut(target, args, icon, workdir) {
  const ps = `
$s = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))) {
  $l = $s.CreateShortcut((Join-Path $dir 'Mixtape.lnk'))
  $l.TargetPath = '${target}'
  $l.Arguments = '${args}'
  $l.WorkingDirectory = '${workdir}'
  $l.IconLocation = '${icon},0'
  $l.Description = 'Mixtape - AI music player'
  $l.Save()
}`;
  const file = path.join(os.tmpdir(), 'mixtape-shortcut.ps1');
  fs.writeFileSync(file, ps);
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${file}"`]);
}

function liteFallback() {
  // App-window mode: hidden server + Edge window with its own taskbar icon. Needs nothing extra.
  const vbs = path.join(DESKTOP, 'Mixtape.vbs');
  shortcut('wscript.exe', `"${vbs}"`, path.join(DESKTOP, 'icon.ico'), ROOT);
  return 'lite';
}

let mode;
try {
  if (process.platform !== 'win32') throw new Error('This installer is for Windows');
  const dist = installElectron();
  assemble(dist);
  setExeIcon();
  shortcut(path.join(TARGET, 'Mixtape.exe'), '', path.join(TARGET, 'Mixtape.ico'), TARGET);
  mode = 'electron';
  log(`Installed to ${TARGET}`);
} catch (e) {
  log('Desktop build failed:', e.message);
  log('Creating the lightweight app-window shortcut instead.');
  mode = liteFallback();
}
fs.writeFileSync(path.join(DESKTOP, 'install-result.txt'), `${mode}\n${mode === 'electron' ? path.join(TARGET, 'Mixtape.exe') : path.join(DESKTOP, 'Mixtape.vbs')}\n`);
console.log(`\nRESULT: ${mode}`);
