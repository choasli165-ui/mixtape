# Installation

Mixtape runs on **Windows 10/11 (x64)** as a desktop app. It can also run as a local web page in your browser on any system with Node.js. The browser version starts on Linux too, but only Windows is regularly tested.

* [Option A: Windows installer](#option-a-windows-installer)
* [Option B: run from source (browser)](#option-b-run-from-source-browser)
* [Option C: build the desktop app from source](#option-c-build-the-desktop-app-from-source)
* [Optional: Claude CLI and MCP](#optional-claude-cli-and-mcp)
* [Optional: stem-separation AI](#optional-stem-separation-ai)
* [Where things are stored](#where-things-are-stored)
* [Updating](#updating) · [Uninstalling](#uninstalling)

## Option A: Windows installer

1. Download `Mixtape-Setup-1.6.1.exe` and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/choasli165-ui/mixtape/releases/latest).
2. Run it. It installs **for your user only** into `%LOCALAPPDATA%\Programs\Mixtape`, with no administrator rights needed, and creates Desktop and Start-menu shortcuts.
3. Launch **Mixtape**.

What the installer does:
* Copies the app (Electron runtime + Mixtape) and registers an uninstaller under *Settings → Apps*.
* If [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is installed, it also registers Mixtape as an **MCP server** for Claude Code (user scope), so you can ask Claude to play music. Nothing changes if Claude Code isn't installed.
* It does **not** need Node.js. The app carries its own runtime.

> **SmartScreen warning:** the installer is not code-signed, so Windows may show "Windows protected your PC". Choose *More info → Run anyway* only if you downloaded it from the official repository. You can always build it yourself instead ([development.md](development.md#building-the-windows-installer)).

## Option B: run from source (browser)

Requirements: [Node.js](https://nodejs.org) **20 or newer**. Use 22.21+ or 24+ if you need a proxy; see [proxy.md](proxy.md). Git is optional.

```bash
git clone https://github.com/choasli165-ui/mixtape.git
cd mixtape
node bin/mixtape.js
```

That's it. There is no `npm install`, because Mixtape has **no npm dependencies**. Your browser opens `http://127.0.0.1:4321`.

Useful commands (`node bin/mixtape.js help` shows all of them):

```bash
node bin/mixtape.js serve --port 4400 --no-open    # another port, don't open a browser
node bin/mixtape.js generate "deep focus ambient techno" --play
node bin/mixtape.js doctor                         # checks the AI and SoundCloud connections
node bin/mixtape.js config                         # shows settings (keys masked)
```

`npm link` inside the folder gives you a global `mixtape` command.

**Windows shortcut:** `scripts\windows\start-mixtape.cmd` does the setup in one go:
* checks Node.js;
* detects a local proxy on ports 7897, 7890, 10809 or 1080;
* registers the MCP server with Claude Code if it's installed;
* runs `doctor`;
* starts the player.

It writes `setup-log.txt` and `server-log.txt` in the project folder (both are git-ignored).

## Option C: build the desktop app from source

On Windows, with Node.js installed, double-click **`scripts\windows\install-desktop.cmd`** or run:

```bat
node desktop\build-desktop.mjs
```

This:
1. downloads Electron 44.8.0 into `desktop\.build`, using the npmmirror mirror if the direct download fails;
2. assembles `%LOCALAPPDATA%\Programs\Mixtape\Mixtape.exe`;
3. sets the icon;
4. creates Desktop and Start-menu shortcuts.

If the Electron download fails completely, it falls back to a lightweight "app window" shortcut that runs the server hidden and opens Microsoft Edge in app mode (`desktop\Mixtape.vbs`).

To produce a distributable installer, see [development.md](development.md#building-the-windows-installer).

## Optional: Claude CLI and MCP

* **For AI playlists** with the default provider, install Claude Code and sign in once. Mixtape calls `claude -p` with tools and MCP disabled and uses your existing login, so it needs no API key. Other providers: [configuration.md](configuration.md).
* **For Claude to control Mixtape** (MCP), the installer and `start-mixtape.cmd` register it automatically. By hand:

```bash
claude mcp add mixtape -- node /absolute/path/to/mixtape/bin/mixtape.js mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "mixtape": { "command": "node", "args": ["C:/path/to/mixtape/bin/mixtape.js", "mcp"] } } }
```

With the desktop app installed, Claude can use the app's own runtime instead of Node.js. The installer registers this for you:

```json
{ "type": "stdio", "command": "%LOCALAPPDATA%\\Programs\\Mixtape\\Mixtape.exe",
  "args": ["%LOCALAPPDATA%\\Programs\\Mixtape\\resources\\app\\bin\\mixtape.js", "mcp"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } }
```

(Write the paths out in full; JSON config files don't expand `%LOCALAPPDATA%`.)

## Optional: stem-separation AI

Creation Mode's Studio, Mashup and Sing tabs need the song-splitting model. The first time you open one of them, Mixtape offers a **one-time download of about 200 MB** (ONNX Runtime plus the Demucs model). The DJ tab doesn't need it. Offline and manual setup: [local-runtime.md](local-runtime.md).

## Where things are stored

| What | Where |
|---|---|
| Settings, library, likes | `%USERPROFILE%\.mixtape-agent\` (`config.json`, `library.json`) |
| Saved liked songs | `…\.mixtape-agent\offline\` |
| Pre-loaded songs (rolling, 30 max) | `…\.mixtape-agent\audio\` |
| Split songs (12 max) | `…\.mixtape-agent\stems\` |
| Stem-separation runtime and model | `…\.mixtape-agent\runtime\`, `…\models\`, or bundled in `resources\app\engine\` |
| Your own song list (optional) | `…\.mixtape-agent\my-songs.json` |
| App (installer) | `%LOCALAPPDATA%\Programs\Mixtape\` |

Set `MIXTAPE_HOME` to use another data folder.

## Updating

* **Installer:** run the newer `Mixtape-Setup.exe`. Your data folder is kept.
* **Source:** `git pull`, then restart. In the desktop app, use tray icon → **Quit**, then open it again.

## Uninstalling

* **Installed app:** *Settings → Apps → Mixtape → Uninstall*, or run `Uninstall Mixtape.exe` in the app folder. This removes the app, its shortcuts and the Claude Code MCP registration.
* **Your data** stays in `%USERPROFILE%\.mixtape-agent`. Delete that folder to remove settings, likes and all cached audio.
