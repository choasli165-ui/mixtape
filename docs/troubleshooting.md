# Troubleshooting

Start with `node bin/mixtape.js doctor`, from the project folder. It checks the AI connection and SoundCloud search and prints exactly what failed.

## The app doesn't start

| Symptom | Fix |
|---|---|
| *"A JavaScript error occurred in the main process … Cannot find module …\resources\app\index.js"* | `resources\app\package.json` is wrong (it must point to `desktop/main.cjs`). Reinstall with the latest installer, or rebuild with `node desktop\build-desktop.mjs`. |
| Nothing happens when launching | Mixtape keeps running in the **tray** when you close the window. Click the tray icon. Only one copy can run at a time. |
| Port 4321 in use | Another Mixtape (or another program) is using it. The desktop app picks a free port automatically. For the browser version, use `node bin/mixtape.js serve --port 4400`. |
| Windows SmartScreen blocks the installer | The installer isn't code-signed. *More info → Run anyway*, if it came from the official repository, or build it yourself ([development.md](development.md)). |

## SoundCloud doesn't load / search fails

* **"Could not discover a SoundCloud client_id"**: soundcloud.com isn't reachable, or SoundCloud changed its website. Check your internet or proxy ([proxy.md](proxy.md)). As a workaround, set an id yourself: `node bin/mixtape.js config set soundcloud.clientId <id>`.
* **`SoundCloud 401/403`**: the id expired. Mixtape refreshes it once automatically; if it keeps failing, delete `~/.mixtape-agent/soundcloud-client-id.json` and restart.
* **Works in your browser but not in Mixtape:**
  * *desktop app:* turn on your proxy client's **System Proxy** mode, then restart Mixtape;
  * *browser version:* set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`, and use Node.js 22.21+ or 24+.
* **Many songs greyed out "Unavailable"**: they're blocked in your region, removed, or previews only. If *every* song fails, Mixtape pauses and asks you to check your connection. Greyed-out songs are retried after 6 hours, or right away if you click them.

## AI playlists

* **"Claude CLI not found"** or no AI reply: install [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) and run it once to sign in. The desktop app also looks in `%USERPROFILE%\.local\bin`. Or switch to a **Custom API** in Settings.
* **Custom API errors:**
  * check the URL (a base URL like `https://host/v1` is fine);
  * check the **API format** (OpenAI vs Anthropic) and the model name;
  * press *Save & test* to see the provider's error message.
* **Local Ollama / LM Studio:**
  * make sure the server is running and the model is pulled or loaded;
  * keep `NO_PROXY=localhost,127.0.0.1` if you use a proxy;
  * small models sometimes return invalid picks. Mixtape fills the gaps from search ranking.
* **Playlist comes back without AI notes**: the AI step failed and Mixtape fell back to search ranking. The progress log says why.

## Creation Mode

* **Setup download fails:** npm or Hugging Face isn't reachable. Use a proxy ([proxy.md](proxy.md)) or copy the model file in manually ([local-runtime.md](local-runtime.md#no-internet-on-this-pc)).
* **"Your graphics card stopped responding" / `887A0005`:** a DirectML driver timeout. Mixtape switches to the CPU automatically. Press **Try again**. To stay on the CPU: *Settings → Creation Mode → Processor only*.
* **Splitting is slow:** the first split of a song takes longer on a CPU; afterwards it's instant (cached).
* **Instrument swap sounds odd:** it works best on single-note parts (a melody or bass line), not chords.

## Sing Mode

* **No microphone / "isn't allowed":** *Windows Settings → Privacy & security → Microphone* → allow **desktop apps**. Plug the mic in before opening Sing Mode.
* **My voice is too quiet:** Mixtape uses the mic exactly as Windows provides it. Raise the level in *Windows Sound settings → Input → your mic → Volume*, or move **Mic volume** in Sing Mode up (up to +24 dB).
* **Delay when hearing myself:** use **wired** headphones (Bluetooth adds 150 ms or more) and close other audio apps. Or turn off *Hear myself*, sing, then **Listen back**.
* **The pitch line reacts to the music:** the mic is hearing your speakers. Use headphones.
* **Booming or rumbling:**
  * sing 10–15 cm from the mic, and keep it off the desk;
  * turn off *Microphone Boost* and audio "enhancements" in the mic's Windows properties;
  * lower the headphone volume if it swells (feedback).

## DJ Mode

* **Scratching does nothing:** **VINYL** must be lit, and grab the record itself, not the outer ring (the ring nudges the speed).
* **Decks drift apart:** press **SYNC** on the deck you want to follow the other. It stays locked while lit.
* **Mix recording** saves a `.webm` file through your browser's download prompt.

## Still stuck?

Open an issue with your Mixtape version, how you run it, and the output of `doctor`. **Mask any API keys** before posting.
