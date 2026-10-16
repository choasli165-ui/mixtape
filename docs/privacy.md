# Privacy and local processing

Mixtape has no accounts, no analytics and no telemetry. It runs a small server on your own computer, bound to `127.0.0.1`. That server rejects requests whose `Host` or `Origin` isn't this computer, and it only proxies audio from SoundCloud hosts.

## Stays on your computer

* **Your library:** playlists, likes, play state and settings, in `~/.mixtape-agent/` (`config.json`, `library.json`). The config file is written with owner-only permissions (`0600`) where the operating system supports it.
* **All audio processing:** stem separation, tempo/key/melody analysis, pitch and tempo changes, instrument swap, effects, DJ scratching and mixing, Sing Mode pitch correction, and WAV export.
* **Your microphone and recordings.** The mic is only opened in Sing Mode, after you allow it, and is processed in your browser engine. Recordings are kept in memory until you **Save** (a file download) or **Discard**.
* **Caches:** audio in `~/.mixtape-agent/audio` (rolling, 30 songs), `…/offline` (liked songs) and `…/stems` (12 songs).
* **Your creations:** versions saved in Creation Mode are copied to `~/.mixtape-agent/inspirations/` (the My Inspirations playlist). They never leave your PC.

## Sent over the network

| Destination | When | What is sent |
|---|---|---|
| **SoundCloud** | Search, playback, matching My Songs, recommendations | Search terms, track ids, stream requests. Like any SoundCloud client: your IP address and a browser-style user agent. No login. |
| **Your LLM provider** (Anthropic via Claude CLI or API, OpenAI-compatible endpoint) | AI playlists, For You, *Save & test* | Your request text; up to about 40 "artist – title" lines from My Songs and Liked Songs; about 90 candidate tracks (id, artist, title, genre/tags, length, play count). **No audio.** Claude CLI uses your Claude Code login. |
| **localhost** (Ollama / LM Studio) | If you configure a local model | Same as above, but it never leaves your PC |
| **npm registry, Hugging Face** | Once, when you choose to download the stem-separation engine | Ordinary download requests |
| **Google Fonts, jsDelivr** | When the player page loads | Ordinary requests for fonts and the hls.js library |
| **soundcloud.com widget** | Only if a stream can't be resolved | The embedded SoundCloud player loads like on any web page |

Your Claude client also talks to Mixtape locally over MCP (stdio) when you ask Claude to play music. What you type to Claude goes to Anthropic under your Claude account, as usual.

## Your controls

* Use a **local LLM** (Ollama / LM Studio) and nothing about your taste leaves your PC.
* **Unlike** a song to delete its saved copy. Delete `~/.mixtape-agent/` to remove everything.
* Keep your API keys in `config.json` or environment variables. **Never commit them**; the repository's `.gitignore` excludes `config.json`, `.env` and your personal song list.

## Third parties

Each service's own privacy policy applies to data you send it: SoundCloud, Anthropic, OpenAI, Google Fonts, jsDelivr, npm and Hugging Face. Mixtape is not affiliated with any of them.
