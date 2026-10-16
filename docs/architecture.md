# Architecture

Mixtape is a small Node.js server plus a web front end, wrapped in an Electron shell on Windows. It has **no npm dependencies**: everything uses Node's standard library, Web APIs and hand-written DSP.

```
┌──────────────────────── Electron (desktop/main.cjs) ────────────────────────┐
│  BrowserWindow ── loads ──▶  http://127.0.0.1:4321  (public/)               │
│  tray, media keys, system proxy → Chromium net.fetch, HTTPS_PROXY for CLI   │
│                                                                             │
│  in-process Node server (src/server.js)                                     │
│   ├─ REST + Server-Sent Events  /api/*                                      │
│   ├─ SoundCloud client (src/soundcloud.js)  ──▶ api-v2.soundcloud.com       │
│   ├─ stream proxy + HLS rewrite (SoundCloud hosts only)                     │
│   ├─ Curator agent (src/agent.js) ──▶ LLM provider (src/llm/*)              │
│   ├─ Library (src/library.js) ── ~/.mixtape-agent/library.json              │
│   ├─ Offline sync (src/offline.js), audio cache (src/create/audio.js)       │
│   └─ Stem engine (src/create/engine.js) ── ONNX Runtime + Demucs (local)    │
└─────────────────────────────────────────────────────────────────────────────┘
      ▲ MCP over stdio (src/mcp.js) ── Claude Code / Claude Desktop
```

## Server (`src/`)

| File | Role |
|---|---|
| `app.js` | Wires config, SoundCloud, library, LLM and curator together; allow-list of stream hosts |
| `server.js` | HTTP routes (playlists, search, likes, generate, stream, proxy, precache, creation engine, config), SSE events, static files, local-only Host/Origin check |
| `soundcloud.js` | `client_id` discovery and caching, search, track lookup, stream resolution (progressive → HLS) |
| `agent.js` | The curator: **plan** (LLM writes searches) → **search** (parallel, de-dup, rank) → **select** (LLM picks and orders) → **assemble** (validate ids, cap 2 per artist, fill gaps) |
| `llm/` | Providers with one interface, `complete({system, prompt})`: `claudeCli.js` (spawns `claude -p` with tools and MCP disabled), `anthropic.js`, `openai.js`; `index.js` has the JSON extraction and retry |
| `library.js` | Playlists, liked songs, built-ins (`liked`, `mine`, `for-you`), taste summary |
| `seed.js` | My Songs matching (`data/my-songs*.json`), For You recommendations |
| `offline.js` | Downloads and removes liked songs |
| `mcp.js` | MCP stdio server: `search_soundcloud`, `create_playlist`, `generate_playlist`, `refresh_recommendations`, `play`, `playback_control`, `now_playing`, `like_track`, `list_playlists`, `get_playlist`, `delete_playlist`, `open_player`. Starts or reuses the player and controls it via `/api/player/command` |
| `create/engine.js` | Stem-separation engine: install (npm tgz + Hugging Face), bundled-engine lookup, DirectML/CPU session, overlap-add chunking, GPU-failure fallback, stem cache |
| `create/audio.js` | Full-song audio download (progressive or HLS segments) and the rolling cache |
| `create/tar.js` | Minimal `.tgz` extractor for the npm packages |
| `config.js` | Defaults, `config.json`, environment overrides, masked public view |

## Front end (`public/`)

| Path | Role |
|---|---|
| `index.html`, `style.css`, `app.js` | Player UI: library, search, playback queue with failure handling, pre-cache, settings, SSE updates |
| `i18n.js`, `i18n/{zh,ja,patterns}.js` | Live translation layer: a MutationObserver translates text nodes and attributes; `data-notr` marks user content (titles, artists) |
| `create/index.js` | Creation Mode shell: tabs, song picker, engine setup screen |
| `create/core.js` | Shared audio context, worker pool, stem loading, effect chains, synced multi-part playback, WAV export |
| `create/studio.js`, `mashup.js`, `dj.js`, `sing.js` | The four tools |
| `dsp/` | Pure-JS DSP: FFT, phase vocoder, analysis (tempo, key, sections), YIN melody, synths, the Sing Mode tuner (`tune.js`), presets, the DJ turntable worklet and sampler sounds |

**Audio worklets:**
* `pitch-worklet.js`: instant pitch preview;
* `tune-worklet.js`: Sing Mode tuner and take recorder;
* `dj-worklet.js`: a turntable with position and velocity, used for scratching, loops, slip and spinback.

Heavy offline work (analysis, phase vocoder, note extraction, synth rendering) runs in `dsp/worker.js` Web Workers.

## Desktop and installer

* `desktop/main.cjs`:
  * runs the server **in-process** and routes `fetch` through Chromium (`net.fetch`), so the Windows system proxy applies;
  * exports the proxy to the Claude CLI;
  * hidden title bar with native window controls, tray, single instance.
* `desktop/build-desktop.mjs` builds the app on Windows from an Electron runtime.
* `installer/` is a Go installer, cross-compiled with no cgo:
  * `setup/` holds the stub that reads a zip payload appended to its own `.exe` (trailer: `uint64 offset` + `MIXTAPE!`);
  * `uninstall/` is the uninstaller;
  * `winui/` is a tiny Win32 progress UI;
  * `common/` covers shortcuts, the uninstall registry key, and Claude Code MCP registration (`claude mcp add-json`, running `Mixtape.exe` with `ELECTRON_RUN_AS_NODE=1`).
* `installer/package.py` assembles the payload and appends it to the stub.

## Data and caches

`~/.mixtape-agent/` (or `$MIXTAPE_HOME`):
* `config.json`
* `library.json`
* `soundcloud-client-id.json`
* `engine.json`: GPU/CPU choice
* `offline/`
* `audio/`
* `stems/`
* `runtime/`
* `models/`
* `my-songs.json`: optional

## Design choices

* **Zero dependencies** keeps installs trivial (copy and run) and the attack surface small.
* **Local-only server**: binds `127.0.0.1` and rejects foreign Host/Origin headers; the stream proxy is restricted to SoundCloud hosts so it can't be used as an open proxy.
* **The LLM is a planner, not a source.** It never invents tracks. Every pick is validated against real search results, and the pipeline still works if the LLM fails.
* **Audio stays local.** The only AI that touches audio (Demucs) runs on your machine through ONNX Runtime.
