# User guide

## The player

* **Sidebar:**
  * **Surprise Me** asks the AI for a new mix.
  * **Creation Mode** and **Sing Mode** open the creative tools.
  * **Search** finds songs (`Ctrl+F`).
  * **Library** holds Liked Songs, My Songs, For You and your playlists.
  * **⚙ Settings** (bottom left) covers the AI provider, language and Creation Mode device.
* **Playlists:**
  * click a row to play it;
  * use ♥ to like and **+** to add the song to a playlist;
  * rename a playlist by clicking its title;
  * **Remix** regenerates a playlist from the same request;
  * delete playlists you don't need.
* **Player bar:**
  * play/pause, previous/next, seek, shuffle, repeat (all / one) and volume;
  * **Create** opens the current song in Creation Mode;
  * **SoundCloud ↗** opens the track on SoundCloud.
* **Keyboard:** `Space` play/pause · `←/→` seek 5 s · `Shift+←/→` previous/next · `L` like. Media keys work too.
* **Unavailable songs** are greyed out and skipped automatically. You get one message for several skips.

### Surprise Me (AI playlists)

Type what you want in plain words. Mood, genre, activity and reference artists all work: *"songs like Bonobo but darker"*, *"Afrobeats & amapiano party"*, *"UK garage & 2-step"*. The AI writes 7–9 searches, Mixtape collects and de-duplicates candidates, and the AI picks and orders 15 songs with a one-line note each. Titles and notes follow your app language.

### Liked Songs, My Songs, For You

* **Liked Songs:** everything you ♥, newest first. Saved on your PC for offline play (see the [SoundCloud notes](soundcloud.md)).
* **My Songs:** your own list from `my-songs.json` ([configuration.md](configuration.md#my-songs)). **Re-match** looks the songs up again.
* **For You:** 15 recommendations related to My Songs and Liked Songs. **Refresh** for a new set.
* **My Inspirations:** every version you save in Creation Mode (a Studio remix or single part, a mashup, a DJ recording, a Sing Mode performance) is added here automatically. The file is kept in `~/.mixtape-agent/inspirations/`, plays like any other song, and **Open in Creation Mode** reopens it (DJ mixes on the decks, everything else in Studio) so you can keep working on it. Removing it from the playlist deletes the copy; the WAV/WebM file you downloaded is not touched.

### Changing the order

Drag a song up or down in any playlist, including Liked Songs and My Inspirations. A line shows where it will land. The new order is saved immediately and kept after a restart. If that playlist is playing, the current song keeps playing and **Next** follows the new order (with Shuffle on, the shuffled sequence is kept).

### Artists

Click an artist name (in a song row, in search results, or on the player bar) to open their artist page: their picture, followers and public SoundCloud tracks, which you can play, ♥ or add to playlists. The page is found by the uploader's unique SoundCloud id, so two artists with the same name never get mixed up. If the credited artist differs from the uploading account (labels, channels), the page says so and offers a search for the credited name. **Open on SoundCloud ↗** opens their profile.

### Search

Type an artist or a title. Your library is shown first, then SoundCloud results; the artist chips narrow the results to one artist. **+** adds a song to Liked Songs, an existing playlist, or a new one.

## Creation Mode

Open it from the sidebar or with **Create** on the player bar. The tabs are Studio, Mashup, DJ and Sing. Opening Creation Mode and switching tabs is instant: nothing is downloaded or processed until you press **Start Creating**, and each tab only loads what it needs (DJ loads just the song; Studio, Mashup and Sing split it into parts first, once per song). The song you had selected stays selected. The first time you use Studio, Mashup or Sing, Mixtape offers the one-time stem-separation download ([local-runtime.md](local-runtime.md)).

### Studio

* **Lanes:** one per part (vocals, drums, bass, guitar, piano, other), each with a live level meter. **M** mutes and **S** solos.
* **Sections:** click a section (Intro, Verse, Drop…) to select it, and double-click to jump there. Changes can apply to the whole song or only the selected section.
* **Editor for the selected part:**
  * volume and pan;
  * pitch (±12 steps);
  * **instrument**: replay the part's notes on piano, guitar, strings, flute, synth lead, choir, music box, marimba, phonk cowbell or 808 bass;
  * **sound effect**: big room, echo, lo-fi, distortion, underwater, telephone or space.
* **Song-wide controls:**
  * **Speed**;
  * **Bass boost**;
  * **Loop selected part**;
  * **⇄ Original** compares with the untouched song;
  * **↶ Undo** (`Ctrl+Z`);
  * **⬇ Save my version** exports a WAV.
* **🎲 Surprise me** scrolls to **Creative ideas**: Phonk it up, Just the voice, Karaoke, Music box dream, Orchestra, Chipmunk, Deep voice, Underwater party, Cowbell melody.
  * Tap an idea to add it, and tap again to remove it.
  * Ideas can be combined; active ones have a bright border and a ✓ On badge.
  * **Random idea** adds one you haven't tried.

### Mashup

Pick song A and song B, then choose which parts come from each. Song B is time-stretched to A's tempo, moved to a compatible key and aligned on the beat. A match score and a short explanation show how well they fit.

### DJ

* **Turntables:**
  * Drag the record to **scratch**; holding it still stops the music.
  * Drag the outer ring, or scroll, to **nudge** the speed.
  * **VINYL** switches scratching on or off.
* **Transport:**
  * **CUE**: when stopped, sets the cue point (hold to preview); while playing, returns to it.
  * **▶︎**: play or pause.
  * **REV**: plays backwards.
  * **SPIN**: a spinback.
  * **BRAKE**: makes start and stop slow, like a turntable.
* **SYNC** matches tempo and lines up the beats with the other deck, and stays locked while lit. **Q** (quantize) snaps cues, loops and jumps to the beat. **SLIP** lets the song carry on underneath scratches, rolls and reverse.
* **Tempo:** the pitch fader has a ±8 / 16 / 50 % range, plus − / + nudge buttons.
* **Loops:** **LOOP** with ÷2 / ×2, **IN / OUT** and **RELOOP**.
* **Pads**, in four modes:
  * **Hot cue:** pre-filled with song sections. Tap an empty pad to save, and shift-click or right-click to clear.
  * **Roll:** hold for a loop roll from 1/16 to 8 beats.
  * **Jump:** ±1 to 16 beats.
  * **Sampler:** synthesised one-shots.
* **FX:** echo, reverb, flanger, crush or gate, timed to the beat, with an amount knob and **FX ON**.
* **Mixer:**
  * per channel: trim, Hi/Mid/Low with ✕ kills, filter, fader and meter;
  * master and sampler volume;
  * crossfader with a *Smooth* or *Sharp cut* curve;
  * **Auto transition**: smooth blend, filter sweep, echo out or quick cut;
  * **● Record my mix** (WebM).
* **Keys:** pads `1–8` (A) and `Q–I` (B) · `Z`/`M` play · `X`/`N` cue · `←`/`→` crossfader.

### Sing Mode

1. Put on **wired headphones**, pick a song, and turn on the microphone.
2. **Start singing.** The music plays and you're recorded. The pitch guide starts fresh, showing the original melody (bars), your voice (thin line) and the corrected voice (orange). Notes turn green, yellow or red, and there's an accuracy score with "a little high / low" tips.
3. **End singing** (or `Space`), or let the song finish. Then **Listen first**, **Save** (a WAV of you with the music) or **Discard**.

Settings:
* **Pitch correction:**
  * *Follow the song* (the original singer's notes; octave up or down is fine), *Song key* or *Off*;
  * key, strength, speed (robotic ↔ natural) and how much vibrato to keep;
  * **language style** (Auto / 中文 / English / 日本語).
* **Sound:**
  * presets: Natural, Pop polish, Ballad, Hard tune, Karaoke room;
  * reverb and type, echo, tone;
  * Advanced: body, clarity, air, evenness, softening of "s" sounds, a doubled voice and a tolerance for small errors.
* **Mix:** my voice, the original singer (default 12 %, a quiet guide) and the music.
* **Your voice:** microphone choice, **Mic volume**, *Hear myself in headphones*, and the delay estimate. **Measure** plays clicks to measure the exact delay; hold the headphones near the mic.

Everything you record stays on your PC unless you save and share it yourself. Please respect the rights of the song's owners ([DISCLAIMER.md](../DISCLAIMER.md)).

## Languages

*Settings → Language*: English, 简体中文 or 日本語. The first launch follows your system language. AI-written titles and notes follow the chosen language. Song titles and artist names are never translated.
