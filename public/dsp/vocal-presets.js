// Sing Mode sound presets and language styles (pure data + merge logic, shared with tests).
const BASE = {
  mode: 'reference', strength: 0.8, speedMs: 60, vibrato: 0.8, toleranceCents: 15,
  reverb: 0.25, reverbType: 'plate', echo: 0.1, comp: 0.5, warmth: 0, presence: 2, air: 2, doubler: 0,
  deessAmount: 0.5, deessHz: 6000, gateDb: -52, inputGainDb: 0,
};
export const PRESETS = {
  natural: { label: 'Natural', desc: 'Gentle help, sounds like you', p: { strength: 0.6, speedMs: 110, vibrato: 1, toleranceCents: 22, reverb: 0.15, reverbType: 'room', echo: 0, comp: 0.3, warmth: 0.5, presence: 1, air: 1, doubler: 0 } },
  pop: { label: 'Pop polish', desc: 'Clean, bright, radio-ready', p: { strength: 0.85, speedMs: 45, vibrato: 0.7, toleranceCents: 10, reverb: 0.25, reverbType: 'plate', echo: 0.1, comp: 0.6, warmth: 0, presence: 3, air: 3, doubler: 0.25 } },
  ballad: { label: 'Ballad', desc: 'Warm and spacious', p: { strength: 0.75, speedMs: 80, vibrato: 1, toleranceCents: 12, reverb: 0.45, reverbType: 'hall', echo: 0.15, comp: 0.45, warmth: 1, presence: 1.5, air: 2, doubler: 0 } },
  hard: { label: 'Hard tune', desc: 'The robotic Auto-Tune effect', p: { strength: 1, speedMs: 0, vibrato: 0, toleranceCents: 0, reverb: 0.2, reverbType: 'plate', echo: 0.15, comp: 0.7, warmth: 0, presence: 3, air: 3, doubler: 0.3 } },
  karaoke: { label: 'Karaoke room', desc: 'Big echo, light correction', p: { strength: 0.5, speedMs: 100, vibrato: 1, toleranceCents: 25, reverb: 0.55, reverbType: 'hall', echo: 0.3, comp: 0.5, warmth: 0.5, presence: 2, air: 1, doubler: 0 } },
};
// Language styles tune correction speed, tolerance, sibilance control and brightness.
export const LANGS = {
  zh: { label: '中文', p: { speedMs: 0.8, toleranceCents: 0.9, deessAmount: 0.55, deessHz: 5500, presence: 0.5, air: 0.5 } },
  en: { label: 'English', p: { speedMs: 1.25, toleranceCents: 1.4, deessAmount: 0.65, deessHz: 6500, presence: 0.5, air: 0 } },
  ja: { label: '日本語', p: { speedMs: 0.7, toleranceCents: 0.8, deessAmount: 0.35, deessHz: 6800, presence: 0.8, air: 1 } },
};
export function guessLanguage(track) {
  const s = `${track?.title || ''} ${track?.artist || ''}`;
  if (/[぀-ヿ]/.test(s)) return 'ja';
  if (/[一-鿿]/.test(s)) return 'zh';
  return 'en';
}
/** Effective vocal settings: base ← preset ← language style ← the user's own tweaks. */
export function effective({ preset = 'pop', lang = 'en', overrides = {} }) {
  const p = { ...BASE, ...(PRESETS[preset]?.p || {}) };
  const L = LANGS[lang]?.p;
  if (L) {
    if (preset !== 'hard') { p.speedMs = Math.round(p.speedMs * L.speedMs); p.toleranceCents = Math.round(p.toleranceCents * L.toleranceCents); }
    p.deessAmount = L.deessAmount; p.deessHz = L.deessHz; p.presence += L.presence; p.air += L.air;
  }
  return { ...p, ...overrides };
}
