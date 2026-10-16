# Contributing to Mixtape

Thanks for your interest! Mixtape is a small hobby project, and every bug report, translation fix or idea helps.

## Ways to help

* **Report bugs:** open an issue with the *Bug report* template. Include your version, how you run Mixtape, and the output of `node bin/mixtape.js doctor`. **Mask API keys.**
* **Improve translations:** `public/i18n/zh.js` (简体中文) and `public/i18n/ja.js` (日本語). Native speakers are very welcome.
* **DSP and creative tools:** better pitch detection, nicer instruments, new Studio "creative ideas", DJ effects.
* **Make it friendlier to platform rules:** see the "Ideas for a more compliant setup" section in [docs/soundcloud.md](docs/soundcloud.md). Opening local audio files in Creation Mode is a great first big contribution.
* **Docs:** if something confused you, it will confuse others too.

## Getting started

```bash
git clone https://github.com/choasli165-ui/mixtape.git
cd mixtape
node bin/mixtape.js     # run
npm test                # test, no network needed
```

See [docs/development.md](docs/development.md) for the layout and build steps, and [docs/architecture.md](docs/architecture.md) for how it fits together.

## Guidelines

* **No new dependencies** without discussing it in an issue first. Mixtape is dependency-free on purpose.
* **Keep changes focused**, one topic per pull request, with tests where it makes sense. DSP code in `public/dsp/` should stay testable in Node.
* **UI text**: write it in English and add translations to **both** `zh.js` and `ja.js` (`npm test` checks they match). Mark song titles, artist names and other user content with `data-notr` so they're never translated.
* **Style**: modern JavaScript (ES modules), 2-space indentation, small functions, comments that explain *why*. Go code is `gofmt`-formatted.
* **Never commit**:
  * API keys, tokens or `config.json`;
  * personal data such as your own `data/my-songs.json`;
  * music or audio files;
  * model weights (`*.onnx`);
  * build outputs (`release/`, `*.exe`, `*.syso`).

  `.gitignore` covers these, but please double-check `git status`.
* **Respect music rights**: don't add features whose main purpose is ripping, permanently storing or redistributing other people's music. See [DISCLAIMER.md](DISCLAIMER.md).
* Add a line to `CHANGELOG.md` under **Unreleased**.

## Pull requests

1. Fork the repo and create a branch (`fix/hls-seek`, `feat/local-files`, …).
2. Make your change, then run `npm test`.
3. Open a pull request using the template. Describe what changed and how you tested it.

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).

## Code of conduct

Be kind and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
