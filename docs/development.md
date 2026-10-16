# Development

## Requirements

* Node.js **20+**. CI runs on 20, 22 and 24. There's no `npm install`; Mixtape has no dependencies.
* For the Windows installer: **Go 1.24+** and an `llvm-windres` / MinGW `windres` (any OS), plus **Python 3** for packaging.
* For the desktop app: Windows, plus network access to download Electron.

## Run and test

```bash
node bin/mixtape.js            # player at http://127.0.0.1:4321
npm test                       # all tests (node --test test/*.test.js)
node --test test/tune.test.js  # one file
```

The tests (`test/`) use a **mock SoundCloud and LLM server** (`test/mock.js`) and synthetic audio. They need no network, no API keys and no music files.

| File | Covers |
|---|---|
| `e2e.test.js` | AI playlist pipeline (mock LLM), library, likes and offline sync, streaming proxy and HLS rewrite, pre-cache, search → playlist, Custom API URLs, security (host allow-list, foreign origins), Claude CLI output parsing, My Songs matching, the MCP server end to end |
| `create.test.js` | Stem separation chunking (mock model), GPU→CPU fallback, bundled engine, HLS full-song download, tar extraction |
| `dsp.test.js` | FFT, phase vocoder, tempo/key detection, melody, synths |
| `tune.test.js` | Sing Mode tuner: detection, correction, vibrato, latency, plain input default, optional clean-up stages |
| `dj.test.js` | Turntable worklet (play, scratch, loops/slip, reverse, spinback, brake), sampler sounds |
| `i18n.test.js` | Chinese and Japanese dictionaries match and patterns translate |

## Project layout

```
bin/            CLI entry (serve, mcp, generate, doctor, …)
src/            Node server, SoundCloud client, LLM providers, MCP server, stem engine
public/         Web UI, Creation Mode, DSP and audio worklets, translations
data/           my-songs.example.json (starter list); your own my-songs.json is git-ignored
desktop/        Electron main process, icons, desktop build script
installer/      Go installer + uninstaller, build.sh, package.py
scripts/windows Windows helpers (start, install desktop)
test/           node:test suites and mock servers
docs/           Documentation
```

## Building the desktop app (Windows)

```bat
node desktop\build-desktop.mjs
```

This downloads Electron 44.8.0 into `desktop\.build\`, assembles `%LOCALAPPDATA%\Programs\Mixtape`, sets the icon with rcedit and creates shortcuts.

## Building the Windows installer

1. **Stub** (Linux, macOS, WSL or Windows with Go and windres):
   ```bash
   bash installer/build.sh          # → installer/dist/setup-stub.exe (version from package.json)
   ```
   Set `WINDRES=/path/to/windres` if it isn't found automatically.
   On Windows, you can build the stub natively with PowerShell and Go 1.24+:
   ```powershell
   npm install --prefix desktop/.build rcedit@4.0.1 --ignore-scripts --no-audit --no-fund
   ./installer/build.ps1 -Rcedit ./desktop/.build/node_modules/rcedit/bin/rcedit-x64.exe
   ```
   The PowerShell command builds the setup and uninstaller without changing an installed copy of Mixtape.
2. **Payload + installer** (any OS with Python 3):
   ```bash
   # from an Electron Windows x64 runtime (e.g. desktop/.build/node_modules/electron/dist):
   python3 installer/package.py --electron desktop/.build/node_modules/electron/dist
   # or from an app you already assembled with build-desktop.mjs (keeps its icon):
   python3 installer/package.py --app-dir "$LOCALAPPDATA/Programs/Mixtape"
   ```
   The result is `release/Mixtape-Setup.exe`. Never ship a personal `data/my-songs.json`; `package.py` excludes it.
3. **Optional, offline-ready build:** `--engine <folder with runtime/ and models/>` bundles the stem-separation engine. Check redistribution rights first ([local-runtime.md](local-runtime.md#bundling-the-engine-in-an-installer)).

`release/`, `installer/dist/`, `*.syso` and `uninstall.exe` are build outputs and are git-ignored.

## Releasing

1. Update `version` in `package.json`. The installer stub and its manifest take the version from there at build time.
2. Move the **Unreleased** notes in `CHANGELOG.md` under the new version.
3. `npm test`, build the stub, package the installer, and smoke-test on Windows: install, play, AI playlist, Creation Mode, uninstall.
4. Tag (`git tag v1.x.y`) and attach `Mixtape-Setup-<version>.exe` to a GitHub release, with `SHA256SUMS.txt`.

## Conventions

* Keep it dependency-free. Small, readable modules; plain ES modules on the front end (no bundler).
* UI text is written in English and translated by the i18n layer. Add new strings to **both** `public/i18n/zh.js` and `ja.js`; `i18n.test.js` checks they match. Mark user content with `data-notr`.
* DSP code in `public/dsp/` should be pure functions or classes, so it can be tested in Node.
* Don't add features that permanently store or redistribute other people's music without considering [SoundCloud's terms](soundcloud.md).
