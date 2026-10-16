# Third-party software, models and services

Mixtape's own code is MIT-licensed and has **no npm dependencies**. It relies on the following third-party components. **None of them are stored in this repository.** They are downloaded by the build or by the app at the moment they're needed, from their original sources.

## Downloaded or bundled software

| Component | Used for | Licence | Where it comes from |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) 44.8.0 (includes Chromium and Node.js) | Desktop app | MIT (Chromium: BSD-style; see `LICENSES.chromium.html` shipped with the app) | npm, by `desktop/build-desktop.mjs` |
| [rcedit](https://github.com/electron/rcedit) 4.0.1 | Setting the desktop app's icon at build time | MIT | npm, at build time only |
| [ONNX Runtime for Node.js](https://github.com/microsoft/onnxruntime) 1.20.1 (`onnxruntime-node`, `onnxruntime-common`) | Running the stem-separation model on your PC | MIT. On Windows the package includes `DirectML.dll` from Microsoft; check its licence terms before you redistribute it yourself | npm registry, on first use of Creation Mode |
| [hls.js](https://github.com/video-dev/hls.js) 1.5.20 (light build) | Playing HLS streams | Apache-2.0 | jsDelivr CDN, loaded by the player page |
| [Inter](https://fonts.google.com/specimen/Inter) and [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) fonts | User interface | SIL Open Font License 1.1 | Google Fonts, loaded by the player page (falls back to system fonts) |
| Go standard library | Windows installer and uninstaller | BSD-3-Clause | Compiled into the installer |

## AI model

| Model | Used for | Licence | Source |
|---|---|---|---|
| Demucs v4 "htdemucs_6s" (Hybrid Transformer Demucs, 6 stems), converted to ONNX (fp16 weights) | Splitting songs into vocals, drums, bass, guitar, piano and other | MIT: the ONNX conversion's model card says it is "MIT-licensed, matching the original HT-Demucs" ([facebookresearch/demucs](https://github.com/facebookresearch/demucs), MIT). Re-check the model card before redistributing the weights | Downloaded from Hugging Face (`adowu/htdemucs-6s-onnx`) on first use |

Mixtape does **not** redistribute the model weights in this repository. If you build an installer with the model bundled (`installer/package.py --engine …`), you are redistributing it: check its licence and model card first.

## Online services (not bundled, used over the network)

* **SoundCloud**: search and streaming. Not affiliated; see [DISCLAIMER.md](DISCLAIMER.md) and [docs/soundcloud.md](docs/soundcloud.md).
* **Anthropic Claude** (through the Claude CLI or the Anthropic API) and any **OpenAI-compatible** API you configure: AI playlist curation only.
* **Google Fonts**, **jsDelivr**: fonts and the hls.js library for the player page.
* **npm registry**, **Hugging Face**: one-time download of the stem-separation runtime and model.

## Sounds and test data

* The DJ sampler sounds (air horn, siren, laser, 808, clap, riser, impact, downlifter) are **synthesised in code** (`public/dsp/dj-sounds.js`). No sample files are used.
* Tests use synthetic tones generated in code. No music files are included.
* `data/my-songs.example.json` lists only artist names and song titles, as search terms, and contains no audio.

## License scope

This license covers Mixtape's own source code only. It does not grant any
rights to music, recordings or other content you access with Mixtape, nor to
third-party services, software or AI models it connects to or downloads.
See DISCLAIMER.md and THIRD_PARTY_NOTICES.md.
