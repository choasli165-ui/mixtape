// Background worker: heavy audio maths off the UI thread.
import { analyze, peaks } from './analyze.js';
import { stretchPitch, processRegion } from './pv.js';
import { extractNotes } from './melody.js';
import { renderNotes } from './synth.js';

const ops = {
  analyze({ mono, rhythm, sr }) { return analyze(mono, sr, rhythm || mono); },
  peaks({ ch, cols }) { return peaks(ch, cols); },
  /** Pitch and/or tempo change per channel; optional region (seconds) = only that part changes. */
  transform({ channels, sr, semitones = 0, tempoRatio = 1, region }, progress) {
    return channels.map((ch, ci) => {
      const p = (v) => progress((ci + v) / channels.length);
      if (region) return processRegion(ch, sr, region.start, region.end, (seg) => stretchPitch(seg, { semitones }, p));
      return stretchPitch(ch, { semitones, tempoRatio }, p);
    });
  },
  notes({ mono, sr, lane, bpm, quantize, offset }) { return extractNotes(mono, sr, { lane, bpm, quantize, offset }); },
  render({ notes, instrument, sr, length, octave }) { return renderNotes(notes, instrument, sr, length, { octave }); },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await ops[op](args, (v) => self.postMessage({ id, progress: v }));
    const transfer = [];
    const collect = (x) => { if (x instanceof Float32Array) transfer.push(x.buffer); else if (Array.isArray(x)) x.forEach(collect); };
    collect(result);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
