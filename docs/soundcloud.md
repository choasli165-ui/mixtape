# SoundCloud: how it works, and the rules

All music in Mixtape comes from **SoundCloud**. Mixtape is **not affiliated with SoundCloud**, is not a registered SoundCloud API application, and uses SoundCloud's **public web endpoints**. Please read this page before you use features that store or transform audio.

## How Mixtape uses SoundCloud

| Step | What happens | Code |
|---|---|---|
| **client_id** | SoundCloud requires a `client_id` on every request. If you haven't set one, Mixtape loads soundcloud.com, finds the id the website itself uses in its JavaScript, and caches it for 7 days. If SoundCloud rejects it (401/403), Mixtape fetches a fresh one. | `src/soundcloud.js` |
| **Search** | `GET api-v2.soundcloud.com/search/tracks`. Results are filtered to full, streamable tracks (no 30-second previews, no blocked tracks, 75 s – 15 min). | `src/soundcloud.js` |
| **AI playlists** | The AI writes 7–9 searches; results are merged, de-duplicated (including re-uploads) and ranked before the AI picks 15. | `src/agent.js` |
| **Streaming** | For each play, Mixtape asks SoundCloud for a fresh stream URL (they expire), preferring progressive MP3, then HLS. The audio is passed through a **local proxy** on `127.0.0.1` that only fetches SoundCloud hosts, so the player can seek; HLS playlists are rewritten to go through it. | `src/server.js` |
| **Fallback** | If no stream can be resolved, the player uses SoundCloud's **official embed widget** (`w.soundcloud.com`). | `public/app.js` |
| **Pre-loading** | A few seconds into a song, the next two in the queue are downloaded into a rolling cache of 30 songs (`~/.mixtape-agent/audio`). | `src/server.js`, `src/create/audio.js` |
| **Liked songs offline** | Liking a song downloads it to `~/.mixtape-agent/offline` and plays it from disk afterwards; unliking deletes it. | `src/offline.js` |
| **Creation Mode** | The song's audio (from cache, or downloaded) is split into stems locally and kept for the 12 most recent songs. | `src/create/` |

You can supply your own id: `node bin/mixtape.js config set soundcloud.clientId <id>`, or the `SOUNDCLOUD_CLIENT_ID` environment variable.

## Dependence and fragility

* `api-v2` is SoundCloud's **internal** API for its own apps. It is undocumented, and SoundCloud can change it, rate-limit it or block it at any time. That would break search and playback until Mixtape is updated.
* Auto-discovering the website's `client_id` is a workaround, not an official integration.
* Some tracks are geo-blocked, removed, or available only as previews. Mixtape greys these out and skips them.

## SoundCloud's API Terms, and where Mixtape stands

SoundCloud's [API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use) govern apps built on its API. The table summarises them; **read the original, which is what counts**, and check for updates.

| SoundCloud's terms say | What Mixtape does | Status |
|---|---|---|
| Apps must **register** and use their own client ID | Uses the website's auto-discovered `client_id` by default | ⚠️ Conflicts. Using your own registered id is better |
| No downloading, file-saving or persistent storage; **no offline listening**; caching only as reasonably necessary for the session, and it must stop being playable when the session ends | Saves liked songs for offline play; the pre-load cache and stems persist between sessions | ⚠️ Conflicts |
| No stream ripping or capture | Stream audio is saved to disk for the offline, cache and Creation features | ⚠️ Conflicts |
| Modifying content (edits, excerpts, derivative works) needs the **uploader's consent**, e.g. a licence allowing it | Creation Mode remixes, mashups, DJ edits and karaoke versions | ⚠️ Only with consent or a suitable licence |
| Content may not be used as **input to AI tools such as source separation** | Stem separation of SoundCloud tracks | ⚠️ Conflicts |
| Credit the uploader and SoundCloud, and link back to the track | Shows artist names; links back via the "SoundCloud ↗" link in the player bar | Partly |
| No "alternative on-demand listening service" aggregating content from many users | Plays search results and AI playlists | ⚠️ Arguable |

**What this means for you.** These features exist because this is a personal, experimental project, and the code is shared for learning. Their existence is **not** a statement that using them on any given SoundCloud track is permitted. If you use Mixtape:

* prefer using it as a **player**: listening and making playlists;
* use Creation Mode only on audio you have the rights to (your own uploads, content whose owner allows it, or suitably licensed music);
* don't redistribute downloaded, separated or remixed audio;
* respect artists. Follow and support them on SoundCloud.

See also [DISCLAIMER.md](../DISCLAIMER.md).

## Ideas for a more compliant setup (contributions welcome)

* Settings to switch off offline saving and persistent caching, so caches are cleared when the app closes.
* Opening **local audio files** in Creation Mode, so it can be used without SoundCloud content.
* Support for a user-registered SoundCloud app (OAuth, "Connect with SoundCloud"), and clearer attribution links.
