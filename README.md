# Mixtape

[![Tests](https://github.com/choasli165-ui/mixtape/actions/workflows/test.yml/badge.svg)](https://github.com/choasli165-ui/mixtape/actions/workflows/test.yml) · [Download for Windows](https://github.com/choasli165-ui/mixtape/releases/latest) · [简体中文安装说明](#简体中文快速开始)

**An ad-free, AI-assisted music player for Windows that turns into a little music playground.**

Describe a mood ("late-night drive, dark synthwave") and an AI curates a 15-song playlist from SoundCloud. Like songs, get recommendations, and play everything in a clean desktop app with no ads. When you feel like playing with the music, there's also a Creation Mode on top:
* split a song into its parts and remix it,
* mash two songs together,
* DJ on two virtual turntables,
* sing along with live pitch correction.

> ⚠️ **Please read the [Disclaimer](DISCLAIMER.md).** Mixtape is an independent hobby project for learning, research and personal fun. It is not affiliated with SoundCloud or Anthropic. Some features, such as offline saving and remixing SoundCloud tracks, go beyond what SoundCloud's API terms allow. You are responsible for how you use music you don't own.

| | |
|---|---|
| **Platforms** | Windows 10/11 (desktop app and installer). The browser version runs anywhere Node.js 20+ runs, but is only tested on Windows and Linux. |
| **Languages** | English, 简体中文, 日本語 |
| **AI** | Claude through the Claude CLI (default), or any Anthropic-compatible / OpenAI-compatible API, including local Ollama and LM Studio. Audio processing is all local. |
| **Licence** | [MIT](LICENSE) for Mixtape's code. Music belongs to its owners. |

---

## Contents

- [Why Mixtape?](#why-mixtape)
- [Features](#features)
- [Quick start (Windows)](#quick-start-windows)
- [How to use it](#how-to-use-it)
- [What needs AI, what runs locally](#what-needs-ai-what-runs-locally)
- [SoundCloud](#soundcloud)
- [Users in mainland China: proxies](#users-in-mainland-china-proxies)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)
- [Contributing](#contributing) · [Licence](#licence)

---

## Why Mixtape?

It started from a simple annoyance: music players full of ads. The first goal was just a clean player. Then it grew:

* **Discovery by description.** You tell it what you're in the mood for, in your own words, and a language model plans the searches and picks and orders the songs. It doesn't rely on an engagement-tuned recommendation feed.
* **Claude can drive it.** Mixtape is also an [MCP](https://modelcontextprotocol.io) server, so you can ask Claude to "make me something for a rainy afternoon and play it", and Claude searches, curates and presses play.
* **Creative tools run on your PC.** Stem separation, pitch shifting, beat matching, scratching and pitch correction all run locally, using open-source models and Web Audio. No audio is uploaded anywhere.

## Features

**Status key:** ✅ complete and in daily use · 🧪 experimental (works, but expect rough edges) · 🗺️ planned (not implemented)

### Listening

| Feature | Status | What it does |
|---|---|---|
| AI playlists ("Surprise Me") | ✅ | Describe a mood, genre or moment, and the AI writes 7–9 SoundCloud searches, picks the best 15 tracks from about 90 candidates, orders them, and adds a short note for each. |
| Search | ✅ | Search by artist or title. Results come from your library first, then SoundCloud, with artist filters. Add any song to a playlist with **+**. |
| Liked Songs | ✅ | Click ♥ on any song; it lands in the built-in Liked Songs playlist. |
| My Inspirations | ✅ | Everything you save in Creation Mode is added to this built-in playlist automatically. Play it, or reopen it in Creation Mode to keep going. Stored on your PC. |
| Artist pages | ✅ | Click any artist name to see that uploader's public SoundCloud tracks (matched by their unique id) and play, like or add them. |
| Drag-and-drop order | ✅ | Drag songs to reorder any playlist. The order is saved and the play queue follows it. |
| My Songs and For You | ✅ | **My Songs** is your own list of songs (a text file) matched on SoundCloud. **For You** is 15 fresh recommendations based on My Songs and your likes, never repeating what you already have. |
| Smooth playback | ✅ | The next two songs are pre-loaded. Broken or slow tracks are greyed out and skipped automatically, so the music doesn't stop. |
| Offline liked songs | ✅ | Liked songs are saved on your PC and play from disk. ⚠️ See [SoundCloud](#soundcloud): this conflicts with SoundCloud's API terms. |
| Desktop app | ✅ | A native Windows app (Electron) with no console window, a tray icon, media keys and a per-user installer. |
| Claude integration (MCP) | ✅ | Claude can search, build playlists, play, skip and like songs through MCP tools. |
| Languages | ✅ | English, Simplified Chinese and Japanese. Switch any time in Settings. |

### Creation Mode 🧪

| Tool | Status | What it does |
|---|---|---|
| **Studio** | 🧪 | Splits a song into **vocals, drums, bass, guitar, piano and other** (Demucs v4, on your PC). For each part you can change the volume, mute or solo it, shift its pitch (for the whole song or one section), replace its instrument (piano, strings, music box, 808…) or add an effect, then export a WAV. **Surprise me** jumps to a set of one-tap **creative ideas** (Karaoke, Phonk it up, Chipmunk…). You can combine several; active ones are highlighted. |
| **Mashup** | 🧪 | Takes parts from two songs. Song B is automatically matched to song A's tempo and key and lined up on the beat, and a score shows how well they fit. |
| **DJ** | 🧪 | A two-deck controller: **scratchable turntables**, CUE, SYNC, quantize, slip, vinyl brake and spinback, reverse, loops (auto, IN/OUT, rolls), **8 performance pads per deck** (hot cues, loop rolls, beat jumps, sampler), per-deck FX (echo, reverb, flanger, crush, gate), a 2-channel mixer with EQ kills and filter, a crossfader, auto transitions and mix recording. |
| **Sing Mode** | 🧪 | Karaoke with **live pitch correction**, like Auto-Tune. It uses the separated backing track and follows the original singer's melody or the song's key. You choose the strength, speed and vibrato, plus language styles (中文 / English / 日本語), presets and effects. It shows a live pitch guide with an accuracy score, then records, lets you listen back, and saves a WAV. The microphone is used as-is, with no automatic gain or noise suppression. |

### Planned 🗺️ (not implemented yet)

* Opening **your own audio files** in Creation Mode (the cleanest way to remix music you have rights to).
* Sing Mode "polish after recording" (higher-quality correction and timing fixes), harmony voices, and changing the song key to suit your voice.
* A native low-latency audio path (ASIO / WASAPI exclusive mode) for live singing.
* Packaged builds for macOS and Linux.

## Quick start (Windows)

**Option A: installer.** Download `Mixtape-Setup-1.6.1.exe` from [Releases](https://github.com/choasli165-ui/mixtape/releases), run it, and open **Mixtape** from the Start menu. No admin rights are needed; it installs to `%LOCALAPPDATA%\Programs\Mixtape`.

**Option B: from source.**

```bash
git clone https://github.com/choasli165-ui/mixtape.git
cd mixtape
node bin/mixtape.js            # opens the player at http://127.0.0.1:4321
```

Requires [Node.js](https://nodejs.org) 20 or newer, with no `npm install` needed because Mixtape has no dependencies. To build the desktop app instead, double-click `scripts\windows\install-desktop.cmd`.

**Then set up the AI** (for AI playlists only; everything else works without it):
* **Claude CLI (default):** install [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) and sign in once. Mixtape uses that login, with no API key.
* **Or a Custom API:** Settings (⚙, bottom left) → **Custom API** → pick a preset (OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, Ollama, LM Studio) or enter any endpoint URL.

Full instructions: [docs/installation.md](docs/installation.md) · AI setup: [docs/configuration.md](docs/configuration.md)

### 简体中文快速开始

1. 在 [Releases](https://github.com/choasli165-ui/mixtape/releases/latest) 下载 `Mixtape-Setup-1.6.1.exe`，支持 Windows 10/11 64 位，安装无需管理员权限。
2. 启动 Mixtape，在 Settings 中切换为简体中文。AI 歌单可使用已登录的 Claude CLI，或在设置中配置自己的 API；发布包不含任何 API 密钥。
3. Studio、Mashup 和 Sing 的音轨分离引擎在首次使用时按需下载；DJ 无需该模型。创作模式仍为实验功能。

安装器暂未代码签名，可用 PowerShell 的 `Get-FileHash .\Mixtape-Setup-1.6.1.exe -Algorithm SHA256` 与同一 Release 的 `SHA256SUMS.txt` 核对。请阅读 [使用说明](docs/user-guide.md)、[隐私说明](docs/privacy.md) 和 [免责声明](DISCLAIMER.md)。

## How to use it

* **"I don't know what I want."** Click **Surprise Me** and type a feeling: *"rainy Sunday, warm jazzy lo-fi with vinyl crackle"*. Rename the playlist, remix it (it regenerates from the same request), or like the songs you love.
* **Make it yours.** Like songs freely; **For You** gets better the more you like. Put your own favourites in `my-songs.json` (see [configuration](docs/configuration.md#my-songs)) and **My Songs** becomes your home playlist.
* **Ask Claude.** With the MCP server registered (the installer does this when Claude Code is installed), say to Claude: *"Play something for a late-night coding session, nothing with vocals."*
* **Take a song apart** (Creation Mode → Studio). Solo the bass to learn a line, mute the vocals for karaoke, replay the melody on a music box, or slow the whole thing down.
* **Mash two songs.** Drums from one, vocals from another; Mixtape matches tempo and key.
* **DJ.** Load two songs, press SYNC, drag the record to scratch, hold a ROLL pad for a stutter, then try **Smooth blend** for a hands-free transition. Keyboard: pads `1–8` / `Q–I`, `Z`/`M` play, `X`/`N` cue, `←`/`→` crossfader.
* **Sing.** Wear wired headphones, press **Start singing**, and watch your pitch line against the original melody. Afterwards, listen back and save or discard. Try the **Hard tune** preset for the robotic effect.

Recording your remix or performance is for personal use: see the [Disclaimer](DISCLAIMER.md).

More detail: [docs/user-guide.md](docs/user-guide.md)

## What needs AI, what runs locally

| Feature | Needs | Network |
|---|---|---|
| AI playlists, For You, AI-written titles and notes | **An LLM**: Claude CLI (default), an Anthropic API key, or any OpenAI-compatible API (cloud or **local** Ollama / LM Studio) | Goes to the LLM provider you choose |
| Claude driving the player (MCP) | Claude Code or Claude Desktop | Your Claude client talks to Mixtape locally |
| Search, playback, likes, playlists, My Songs matching | **No AI** | SoundCloud |
| Stem separation (Studio, Mashup, Sing) | **Local AI model**, Demucs v4 via ONNX Runtime, with no external AI service. GPU (DirectML) when available, otherwise CPU | One-time download of about 200 MB (npm registry and Hugging Face) unless bundled |
| Tempo, key, melody, pitch correction, instrument swap, effects, DJ, scratching | **No AI**: classic signal processing in JavaScript | None |

If the AI can't be reached (for example the Claude CLI isn't installed), **Surprise Me** still works: it searches SoundCloud with your words, ranks the results itself and tells you the AI step was skipped. Everything else works without AI. Details: [docs/configuration.md](docs/configuration.md) · [docs/local-runtime.md](docs/local-runtime.md)

## SoundCloud

All music comes from SoundCloud. Mixtape:

* **Searches and streams** through SoundCloud's public web endpoints (`api-v2.soundcloud.com`), using a `client_id` it discovers from soundcloud.com automatically. It is **not** a SoundCloud-registered API app. You can set your own id with `mixtape config set soundcloud.clientId …`.
* **Streams through a local proxy** (`127.0.0.1` only), so the player can seek and play HLS streams. If a stream can't be resolved, it falls back to SoundCloud's official embed widget.
* **Caches audio on your PC:**
  * liked songs are kept permanently in `~/.mixtape-agent/offline`;
  * the next songs are pre-loaded into a rolling 30-song cache;
  * split songs are kept, 12 at most;
  * unliking a song deletes its file.
* Only shows full-length, streamable tracks. Previews, blocked tracks and anything under 75 s or over 15 min are skipped.

**Limitations and rules.** SoundCloud's [API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use):
* forbid offline storage and stream capture;
* require uploader consent for remixes and derivative works;
* forbid using content as input to AI tools such as source separation;
* require registered client IDs and attribution.

Mixtape's offline saving, persistent caching and Creation Mode on SoundCloud tracks don't fit those rules. Use them only where you have the right to, for example with your own uploads or with content whose licence allows it. SoundCloud may also change or block these endpoints at any time, which would break search and playback. Full details: [docs/soundcloud.md](docs/soundcloud.md).

## Users in mainland China: proxies

Some services Mixtape uses may be unreachable without a network proxy in mainland China. **Not every feature needs one:**

| Needs internet access to… | Feature |
|---|---|
| SoundCloud | search, streaming, matching, recommendations |
| Your LLM provider (Claude, OpenAI, …) | AI playlists, unless you use a domestic API such as DeepSeek, or a local Ollama / LM Studio |
| npm registry and Hugging Face | one-time stem-separation download (or copy the model file in manually) |
| Nothing (offline) | already-saved liked songs, already-split songs, DJ / Studio / Sing on cached songs, all audio processing |

The **desktop app uses your Windows system proxy automatically** (Clash, v2rayN and similar in "system proxy" mode) and passes it on to the Claude CLI. For the browser version, set `HTTPS_PROXY` and use Node.js 22.21+ or 24+ (`scripts\windows\start-mixtape.cmd` detects common local proxy ports for you). Step-by-step: [docs/proxy.md](docs/proxy.md).

## Privacy

* **Local by default.** The player runs at `http://127.0.0.1:4321` and accepts requests only from this computer. Your library, likes, settings and caches stay in `~/.mixtape-agent` (`%USERPROFILE%\.mixtape-agent` on Windows). The config file is written with owner-only permissions where the OS supports it.
* **Audio never leaves your PC.** Stem separation, analysis, pitch correction, your microphone and your recordings are all processed locally.
* **What goes out:**
  * **SoundCloud** receives your searches and stream requests, like any SoundCloud client.
  * **Your LLM provider** receives your playlist request, artist and title lists of candidate tracks, and up to about 40 artist/title pairs from your My Songs and Liked Songs as "taste" context.
  * **Google Fonts and jsDelivr** receive ordinary page-asset requests.
  * **npm and Hugging Face** are contacted for the one-time model download.
* No analytics, telemetry or accounts of its own.

More: [docs/privacy.md](docs/privacy.md)

## Known limitations

* **SoundCloud dependence.** Mixtape uses unofficial endpoints and an auto-discovered `client_id`, so SoundCloud can break it at any time. Several features conflict with SoundCloud's API terms (see above).
* **Windows-first.** The desktop app and installer are Windows x64 only. The browser version starts on Linux, but macOS and Linux aren't regularly tested, and GPU acceleration for stem separation is Windows-only (DirectML).
* **Creation Mode is experimental:**
  * stem separation quality varies by song;
  * instrument swap works best on single-note lines (melodies, bass), not chords;
  * the first split of a song takes about 15 s to a few minutes, depending on your GPU or CPU;
  * GPU acceleration uses DirectML (any DirectX 12 card, no CUDA). Some drivers, especially on laptops and integrated graphics, reset under load (`887A0005`). Mixtape then falls back to the processor; see [GPU acceleration](docs/local-runtime.md#gpu-acceleration-directml-no-cuda-needed).
* **Sing Mode is experimental:**
  * so far it's only been tested with synthetic voices and one real setup;
  * live monitoring delay depends on your sound card. Expect roughly 30–50 ms with wired headphones and far more with Bluetooth;
  * the microphone is used as-is, so speaker bleed and room noise can confuse the pitch guide (use headphones);
  * the optional input clean-up stages (auto level, low cut, hum removal, bleed guard) exist in the code but are switched off.
* **DJ Mode** uses tempo changes like a turntable (pitch moves with tempo; no key lock). It records the mix as WebM.
* **No lyrics.** SoundCloud doesn't provide them.
* **LLM quality varies.** Small local models sometimes return invalid picks. Mixtape validates them and fills gaps from search ranking.
* **Testing.** There are 56 automated tests (`npm test`) plus manual testing on one Windows PC. There is no code signing, so Windows SmartScreen may warn about the installer.

## Documentation

| Guide | |
|---|---|
| [Installation](docs/installation.md) | Installer, source, desktop build, uninstalling |
| [User guide](docs/user-guide.md) | Every screen and workflow |
| [AI and API configuration](docs/configuration.md) | Claude CLI, Custom API, presets, environment variables, My Songs |
| [Local runtimes](docs/local-runtime.md) | Stem-separation model, GPU/CPU, offline setup, what runs where |
| [SoundCloud](docs/soundcloud.md) | How search, streaming and caching work; terms and limitations |
| [Proxy guide](docs/proxy.md) | Mainland China and other restricted networks |
| [Privacy](docs/privacy.md) | Data flows in detail |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and fixes |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [Development](docs/development.md) | Running tests, building the app and installer, releasing |

## Contributing

Contributions are welcome: bug reports, translations, DSP improvements, new creative ideas. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md).

## Licence

Mixtape's source code is released under the [MIT License](LICENSE). Third-party software and models keep their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Music and other content accessed through Mixtape belong to their respective owners ([DISCLAIMER.md](DISCLAIMER.md)).

*Mixtape was built through natural-language collaboration with Claude, Anthropic's AI model. It is not an Anthropic product.*
