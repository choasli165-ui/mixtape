# Changelog

All notable changes to Mixtape. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.6.1] – 2026-10-16
### Fixed
- Reject opaque and cross-origin browser requests to the local API, with an HTTP regression test. Same-origin desktop/browser requests and CLI/MCP clients remain supported.
- Build distribution packages from a clean application tree, excluding personal data, stale app files and implicitly bundled AI engines.
- Include Mixtape's license, third-party notices and the Go runtime license in desktop distributions.
- Run tests consistently on Windows and Unix, including Node.js 20, without shell wildcard expansion.

### Changed
- Upgrade the Windows desktop runtime to Electron 44.8.0.
- Publish a Windows x64 installer without prebundled AI models; stem separation is an optional first-use download.
- Add native PowerShell installer builds, SHA-256 release checksums, repository links and Windows/Linux CI coverage.

## [1.6.0] – 2026-10-16
### Added
- **My Inspirations**, a built-in playlist. Every version saved in Creation Mode (Studio remix or part, mashup, DJ recording, Sing performance) is added automatically, kept in `~/.mixtape-agent/inspirations/`, playable like any song, and can be reopened in Creation Mode. The downloaded file is still saved as before.
- **Artist pages.** Artist names in song rows, search results and the player bar open the uploader's page (by SoundCloud user id) with their public tracks: play, like, add to playlist. Loading, empty and error (with retry) states. New API: `GET /api/artists/:userId`, `GET /api/artists/by-track/:trackId`.
- **Drag-and-drop ordering** in playlists, Liked Songs and My Inspirations, with an insertion line. Saved immediately (`PUT /api/playlists/:id/order`); the play queue follows the new order without interrupting the current song.
- Settings → Creation Mode: device status in plain language (what is used and why), technical details, **Try graphics card again**, and a graphics-card picker on PCs with more than one.
- Creation Mode shows *Using: graphics card (name)* / *Using: processor* while splitting.

### Changed
- **Creation Mode opens instantly.** Nothing is loaded until you press **Start Creating**; each tab loads only what it needs (DJ needs no splitting). The selected song is kept.
- **GPU handling rewritten.** One DirectML error no longer disables the GPU forever: Mixtape warms up each adapter and keeps the fastest working one, falls back to the processor for that song, retries next time, and only switches the GPU off after 3 failures in a row. Old settings are migrated. Documented requirements: DirectML, any DirectX 12 GPU, no CUDA.
- Your own creations are never pre-cached or marked "unavailable".

### Open-source preparation
- New README and full documentation in `docs/`: installation, user guide, AI configuration, local runtimes, SoundCloud, proxy guide, privacy, troubleshooting, architecture, development.
- Added `LICENSE` (MIT), `DISCLAIMER.md`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates and a test workflow.
- The bundled song list is now a small starter list (`data/my-songs.example.json`). Your own `data/my-songs.json` or `~/.mixtape-agent/my-songs.json` is still used, and is git-ignored.
- Windows helper scripts moved to `scripts/windows/` (`start-mixtape.cmd`, `install-desktop.cmd`).
- `installer/build.sh` finds `windres` automatically and stamps the version from `package.json`. The new `installer/package.py` builds `release/Mixtape-Setup.exe` reproducibly (replaces `make-setup.py`).

## [1.5.3] – 2026-10-16
### Changed
- Studio: **Surprise me** scrolls to a permanent **Creative ideas** section. Ideas toggle on and off, can be combined, and are highlighted with a bright border and a ✓ On badge, worked out from the song's real state (works with Undo and manual edits). New **Random idea** button.

## [1.5.2] – 2026-10-16
### Changed
- Sing Mode uses the microphone as-is: no automatic gain, noise suppression, echo cancellation, gate or filters. The optional clean-up stages are kept in the engine but switched off. A plain **Mic volume** control replaces the extra settings.

## [1.5.1] – 2026-10-16
### Added
- Sing Mode microphone clean-up (now off by default): adaptive 24 dB/oct low cut, 50/60 Hz hum removal, pop/thump guard; effect sends no longer carry low frequencies.

## [1.5.0] – 2026-10-16
### Added
- **DJ Mode rebuilt as a two-deck controller**: an audio-thread turntable engine with scratching, vinyl brake, spinback, reverse and slip; CUE/SYNC/Q; loops (auto, IN/OUT, reloop); 8 performance pads per deck (hot cues, loop rolls, beat jumps, synthesised sampler); per-deck FX; mixer with trim, EQ kills, filter, faders and LED meters; crossfader curves; scrolling beat-grid waveforms; keyboard shortcuts.
- Sing Mode sessions: **Start singing** records automatically, **End singing** stops, then save / discard / listen first. The pitch guide resets for every session.
- Sing Mode: louder vocals (automatic level, limiter), Headphones/Speakers setting with echo cancellation, music-bleed guard, noise floor tracking. All later made optional, see 1.5.2.

## [1.4.0] – 2026-10-16
### Added
- **Sing Mode (experimental)**: karaoke backing from the split song, live pitch correction (YIN + PSOLA AudioWorklet) that follows the original melody or the song key, presets and language styles (中文 / English / 日本語), effects, live pitch guide with scoring, latency estimate and measurement, recording and WAV export.

## [1.3.0] – 2026-10-16
### Added
- Music search by artist or title, with add-to-playlist.
- **Custom API** settings with presets (OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, Ollama, LM Studio) and free endpoint URLs.
- Playback failure handling: broken or slow tracks are greyed out and skipped automatically.
- The stem-separation engine can be bundled with the app for offline use.
### Changed
- "New mix" renamed to **Surprise Me** (来点惊喜 / サプライズ).

## [1.2.0] – 2026-10-15
### Added
- Windows installer and uninstaller (Go) with Claude Code MCP registration.
- **Creation Mode**: Studio (6-stem separation with Demucs v4 via ONNX Runtime, per-part pitch/instrument/effects, WAV export), Mashup (tempo and key matching), DJ (two decks, sync, EQ, loops, transitions, mix recording).
- Automatic GPU → CPU fallback for stem separation.
- Liked songs saved on the PC; pre-caching of the next songs.
- Chinese and Japanese user interface.

## [1.0.0 – 1.1.0] – 2026-10-15
### Added
- AI music player agent: an LLM plans SoundCloud searches and curates 15-track playlists; Claude CLI by default, Anthropic and OpenAI-compatible APIs as alternatives.
- Web player with Liked Songs, playlists, keyboard and media keys.
- MCP server so Claude can search, curate and control playback.
- My Songs (personal list matched on SoundCloud) and For You recommendations.
- Electron desktop app with hidden title bar, tray and system-proxy support.
