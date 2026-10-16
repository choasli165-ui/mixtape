# Disclaimer, copyright and platform rules

**Please read this before using Mixtape with music you don't own.** This document explains how Mixtape relates to copyright and to the services it connects to. It is not legal advice, and it does not remove anyone's legal responsibility. Laws differ between countries, so if you are unsure whether something is allowed, ask a qualified lawyer in your country.

## What Mixtape is

Mixtape is an independent, open-source project. It is intended for **learning, research, experimentation and personal entertainment**. It is a piece of software that runs on your own computer. It is not a music service, it hosts no music, and its authors do not provide, sell or license any music.

## Music belongs to its owners

* Mixtape does not provide or claim ownership of any copyrighted music.
* All music, recordings, compositions, lyrics, artwork and other third-party content you reach through Mixtape remain the property of their respective copyright holders.
* Please respect artists, creators and copyright owners. If you enjoy someone's music, support them on the platforms where they publish it.

## You are responsible for how you use it

You are responsible for making sure your use of Mixtape follows the laws that apply to you, the licence of each piece of music, and the terms of every platform involved. This applies to everything Mixtape can technically do, including:

* **downloading or caching** audio (for example saving liked songs on your PC, or pre-loading the next song),
* **stem separation** (splitting a song into vocals, drums, bass, etc.),
* **remixing, mashups, DJ mixes, pitch or instrument changes**,
* **recording** your singing over a song, and
* **exporting or redistributing** any resulting audio file.

**The fact that Mixtape can do something does not mean you are allowed to do it with a particular song.**

## Edited audio is not copyright-free

Remixes, mashups, DJ mixes, separated stems, karaoke tracks and recordings of you singing over a song are generally **derivative works** of the original. Changing the pitch, tempo or instruments, or mixing in your own voice, does **not** make the result copyright-free and does not give you the right to publish it. Unless you have permission from the rights holders, or the music's licence allows it, keep such creations private, for your own learning and enjoyment.

## SoundCloud

Mixtape is **not affiliated with, endorsed by or sponsored by SoundCloud**. "SoundCloud" is a trademark of its owner and is used here only to describe what Mixtape connects to.

How Mixtape talks to SoundCloud matters, and you should know it before you use it:

* Mixtape uses SoundCloud's **public web endpoints** (`api-v2`), with the same kind of `client_id` that the SoundCloud website uses. By default it discovers that id automatically. It is **not** a SoundCloud-registered API application.
* SoundCloud's [API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use) set rules for apps built on its API. In summary (read the original, which is what counts), they:
  * do not allow apps to save, download or persistently store content, or to offer offline listening. Only caching "reasonably necessary" for the current session is allowed;
  * do not allow stream ripping or capture;
  * require the uploader's consent to modify content or create derivative works, such as edits, excerpts and remixes;
  * do not allow content to be used as input to AI tools such as **source separation**;
  * require apps to register for their own client ID, and to credit the uploader and SoundCloud, with links back.
* Several Mixtape features go beyond what those terms allow for SoundCloud content: saving liked songs for offline playback, the pre-load cache that persists between sessions, and Creation Mode (stem separation, remixing, mashups and DJ edits) applied to SoundCloud tracks.
* SoundCloud can change its endpoints, block access, or enforce its terms at any time. Your use of SoundCloud through Mixtape is also governed by SoundCloud's general [Terms of Use](https://soundcloud.com/terms-of-use).

Treat the creative features as tools for music you have the rights to use, such as your own recordings, music under a licence that allows remixing (for example some Creative Commons licences), or content whose owner has given you permission. See [docs/soundcloud.md](docs/soundcloud.md) for the technical details, and the [Known limitations](README.md#known-limitations) section of the README.

## AI services

Mixtape is **not affiliated with Anthropic**, OpenAI or any other AI provider. "Claude" is a product of Anthropic. When you use the Claude CLI or a custom API, your requests go to that provider under your own account and are governed by that provider's terms and privacy policy. AI-generated playlist titles and descriptions may be inaccurate.

## Open-source models and software

The stem-separation model (Demucs v4, 6-stem, in ONNX format) and ONNX Runtime are third-party projects with their own licences. They are downloaded from their original locations when you first use Creation Mode. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## No warranty

Mixtape is provided "as is", without warranty of any kind, as stated in the [LICENSE](LICENSE). The authors are not liable for how the software is used.
