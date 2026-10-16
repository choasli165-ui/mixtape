# Local runtimes: what runs on your PC

Everything that touches **audio** runs on your own computer. No external AI service is involved, and no audio is uploaded.

| Part | How it runs | Where the code is |
|---|---|---|
| Stem separation (vocals, drums, bass, guitar, piano, other) | **Demucs v4 6-stem** model in ONNX format, run by **ONNX Runtime for Node.js** inside the Mixtape server. Uses the GPU via DirectML on Windows when it can, otherwise the CPU | `src/create/engine.js` |
| Tempo, beat grid, key, sections | Pure-JavaScript signal processing in a Web Worker | `public/dsp/analyze.js` |
| Melody / note detection (instrument swap, Sing Mode reference) | YIN pitch tracking | `public/dsp/melody.js` |
| Pitch and tempo changes | Phase vocoder (high quality) plus a real-time grain shifter for instant previews | `public/dsp/pv.js`, `pitch-worklet.js` |
| Instrument swap | Small built-in synthesisers (piano, strings, flute, choir, music box, marimba, 808, cowbell…) | `public/dsp/synth.js` |
| Live pitch correction (Sing Mode) | YIN detection + PSOLA pitch shifting in an AudioWorklet, about 5–20 ms of processing delay | `public/dsp/tune.js`, `tune-worklet.js` |
| Turntables, scratching, loops (DJ) | A custom AudioWorklet "record" with position and velocity | `public/dsp/dj-worklet.js` |
| Sampler sounds | Synthesised in code; no sample files | `public/dsp/dj-sounds.js` |
| Effects, mixing, export | Web Audio API (Chromium's audio engine), WAV encoding in JavaScript | `public/create/core.js` |

## The stem-separation engine

| | |
|---|---|
| Model | `htdemucs_6s_fp16weights.onnx` (about 131 MB), from Hugging Face [`adowu/htdemucs-6s-onnx`](https://huggingface.co/adowu/htdemucs-6s-onnx), an ONNX conversion of Meta's [Demucs](https://github.com/facebookresearch/demucs). MIT licence according to its model card. |
| Runtime | `onnxruntime-node` 1.20.1 and `onnxruntime-common` from the npm registry (MIT), about 60 MB after unpacking |
| Download | One time, when you first open Studio, Mashup or Sing and press **Download and set up** |
| Speed | Each song is split once and cached (the 12 most recent are kept). With a GPU, about 15–60 s per song; on a CPU it takes longer |

### GPU acceleration (DirectML, no CUDA needed)

Mixtape runs the model with **ONNX Runtime's DirectML execution provider**. DirectML is part of Windows and works with any DirectX 12 graphics card from NVIDIA, AMD or Intel, including integrated graphics.

| You need | You don't need |
|---|---|
| Windows 10 (1903 or later) or Windows 11, 64-bit | CUDA or the CUDA toolkit |
| A DirectX 12 capable graphics card | cuDNN, PyTorch or Python |
| An up-to-date graphics driver from NVIDIA, AMD or Intel | An NVIDIA card specifically |

`DirectML.dll` comes with the ONNX Runtime download, so there is nothing extra to install. On macOS and Linux the model always runs on the processor.

**How the device is chosen.**
* **Automatic (default).** The first time a song is split, Mixtape runs a short warm-up on each graphics adapter Windows reports (up to three, for laptops with integrated and dedicated graphics), keeps the fastest one that works, and remembers it.
* If every adapter fails, it uses the **processor** for that song and tries the graphics card again next time. After **3 failures in a row** the graphics card is switched off until you press **Try graphics card again** in Settings. A song that finishes on the graphics card resets the count.
* If the graphics card stops responding **in the middle** of a song, Mixtape finishes that song on the processor and tells you.
* **Settings → Creation Mode** shows what is in use (*Now using: graphics card — NVIDIA GeForce …* or *processor*), why the graphics card was not used (in plain words, with the technical error under *Technical details*), a graphics-card picker when you have more than one, and *Processor only* if you prefer.
* While a song is being split, Creation Mode shows *Using: graphics card* or *Using: processor*.

**Common errors.**

| Error | Meaning | What helps |
|---|---|---|
| `887A0005` (device removed), `887A0006` (hung), `887A0007` (reset) | Windows reset the graphics driver, usually because one step took longer than Windows allows (a **TDR timeout**, 2 seconds by default). Common with integrated graphics, laptops on battery and older drivers | Update the graphics driver, plug in the laptop, close games or other GPU-heavy apps, or pick the dedicated graphics card in Settings. Mixtape retries automatically and falls back to the processor |
| `887A0004` / not supported | The card or driver doesn't support DirectX 12 / DirectML | Update the driver, or use *Processor only* |
| Out of memory (`8007000E`) | Not enough graphics memory | Close other apps; the processor still works |
| `LoadLibrary` / `DirectML.dll` | The runtime files are incomplete | Remove the `engine` folder in `%USERPROFILE%\.mixtape-agent` and set up the engine again |

> Advanced: Windows' TDR delay can be raised with the `TdrDelay` registry value. Changing it affects the whole system, so Mixtape never does it for you; only change it if you understand the risk.

**Before version 1.6** a single graphics-card error switched the GPU off permanently. Old settings are migrated automatically: the graphics card gets tried again.

### Where Mixtape looks for the engine

1. **Bundled:** `MIXTAPE_ENGINE_DIR`, or `engine/` next to the app code (`resources\app\engine\` in the desktop app), containing:
   ```
   engine/
     runtime/node_modules/onnxruntime-node/…   (with bin/napi-v3/win32/x64)
     runtime/node_modules/onnxruntime-common/…
     models/htdemucs_6s_fp16weights.onnx
   ```
2. **Downloaded:** `%USERPROFILE%\.mixtape-agent\runtime\` and `…\models\`.

### No internet on this PC?

Download `htdemucs_6s_fp16weights.onnx` on another machine and copy it into the model folder shown on Creation Mode's setup screen (`…\.mixtape-agent\models\`). Copy the runtime folder the same way, or install the desktop app from an installer that bundles the engine.

### Bundling the engine in an installer

`installer/package.py --engine <folder>` puts the engine into the installer so splitting works offline right away. Before you **publish** such an installer, check that you're allowed to redistribute everything in it: the model (see its model card) and ONNX Runtime including `DirectML.dll`. The default public build should leave the engine out; it downloads on first use. **Never commit the model or runtime to git** (`.gitignore` excludes them).

## Microphone (Sing Mode)

The microphone is opened with echo cancellation, noise suppression and automatic gain **turned off**, and Mixtape adds no input processing. Your voice is used as Windows delivers it. Set its level in Windows (*Sound settings → Input*) or with **Mic volume** in Sing Mode.

The engine (`public/dsp/tune.js`) also contains optional clean-up stages (automatic level, 24 dB/oct low cut, mains-hum notches, thump guard, music-bleed guard). They are switched off with `inputProcessing: false` and kept for future experiments.

Latency: about 5–20 ms of processing (it adapts to your voice), plus your sound card's input and output buffers. That's usually 30–50 ms in total with wired headphones on Windows. Bluetooth adds 150 ms or more, so record, then listen back instead.
