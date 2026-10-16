# Proxy guide (mainland China and other restricted networks)

In some regions, including mainland China, some of the services Mixtape talks to may be blocked or very slow without a proxy. **You only need a proxy for the features that use those services.** Mixtape itself always runs locally.

## Which features need which service

| Feature | Connects to | Proxy usually needed in mainland China? |
|---|---|---|
| Search, playback, My Songs matching, For You | `soundcloud.com`, `api-v2.soundcloud.com`, SoundCloud's media hosts | Usually yes |
| AI playlists with **Claude CLI** or the **Anthropic API** | `api.anthropic.com` (and Claude Code's own services) | Yes |
| AI playlists with **OpenAI** / **OpenRouter** / **Groq** | Their APIs | Usually yes |
| AI playlists with **DeepSeek** or other domestic providers | Their APIs | Usually no |
| AI playlists with **Ollama / LM Studio** on your PC | `localhost` | No |
| Stem-separation download (one time) | `registry.npmjs.org`, `huggingface.co` | Often yes, or copy the files in manually ([local-runtime.md](local-runtime.md#no-internet-on-this-pc)) |
| Fonts, HLS player library | `fonts.googleapis.com`, `cdn.jsdelivr.net` | Sometimes. Fonts fall back to system fonts; some HLS-only tracks may not play without jsDelivr |
| Liked songs saved offline, split songs, DJ / Studio / Sing on cached songs | Nothing | No |
| Everything audio-related (separation, pitch correction, effects) | Nothing | No |

## Desktop app (recommended): system proxy

The desktop app sends its network requests through **Chromium's network stack**, so it follows the **Windows system proxy**.

1. In your proxy client (Clash, Clash Verge, v2rayN, …) turn on **System Proxy**. *TUN / virtual adapter* mode also works.
2. Start, or restart, Mixtape.

The app also finds the system proxy for `api.anthropic.com` and passes it to the **Claude CLI** as `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY=localhost,127.0.0.1,::1`.

Check: run `node bin/mixtape.js doctor` from a terminal that uses the same proxy, or use **Settings → Save & test** for the AI.

## Browser / source version: environment variables

Node.js does not read the Windows system proxy. Set environment variables instead. Node's built-in `fetch()` uses them from **Node.js 22.21+ or 24+** when `NODE_USE_ENV_PROXY=1` is set ([Node.js docs](https://nodejs.org/learn/http/enterprise-network-configuration)).

**Windows (cmd):**

```bat
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=%HTTPS_PROXY%
set NO_PROXY=localhost,127.0.0.1,::1
set NODE_USE_ENV_PROXY=1
node bin\mixtape.js
```

**PowerShell:**

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7890"; $env:HTTP_PROXY=$env:HTTPS_PROXY
$env:NO_PROXY="localhost,127.0.0.1,::1"; $env:NODE_USE_ENV_PROXY="1"
node bin/mixtape.js
```

**macOS / Linux:**

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=1
node bin/mixtape.js
```

Replace `7890` with your client's **HTTP** port. Common defaults are 7890 for Clash, 7897 for Clash Verge and 10809 for v2rayN's HTTP port. Use the HTTP port, not SOCKS.

`scripts\windows\start-mixtape.cmd` does this automatically: if no `HTTPS_PROXY` is set, it looks for a local proxy listening on 7897, 7890, 10809 or 1080.

**Always keep `NO_PROXY=localhost,127.0.0.1,::1`.** Otherwise requests to the local player, or to Ollama / LM Studio, are sent to the proxy and fail.

## Building the desktop app behind a proxy

`desktop/build-desktop.mjs` downloads Electron from npm and GitHub. It honours `HTTPS_PROXY`, and if the direct download fails it retries through the **npmmirror** Electron mirror (`https://npmmirror.com/mirrors/electron/`). You can also set `npm config set registry https://registry.npmmirror.com` for the npm part.

## Without any proxy

You can still use:
* local AI playlists with **Ollama / LM Studio**, or a domestic API;
* anything already cached (liked songs saved offline, split songs);
* every creative tool on cached songs.

Search and new streams need SoundCloud.

## Notes

* Make sure your use of proxies and of each service complies with the laws and rules that apply to you.
* If SoundCloud works in your browser but not in Mixtape, the proxy isn't reaching Mixtape. See [troubleshooting.md](troubleshooting.md#soundcloud-doesnt-load--search-fails).
