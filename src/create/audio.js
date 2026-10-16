// Full-song audio for Creation Mode: downloads the whole stream (progressive or HLS) once and caches it.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './engine.js';

const EXT = (mime) => (/mpeg/.test(mime) ? 'mp3' : /ogg|opus/.test(mime) ? 'ogg' : 'm4a');
const MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm' };
const pending = new Map();

const safe = (id) => String(id).replace(/[^\w-]/g, '_');

/** Find a local copy: your saved creations, liked-song downloads, then the Creation Mode cache. */
export function cachedAudio(id, dirs = [paths.inspirations(), paths.offline(), paths.audio()]) {
  for (const dir of dirs) for (const ext of Object.keys(MIME)) {
    const p = path.join(dir, `${safe(id)}.${ext}`);
    if (fs.existsSync(p)) return { file: p, mime: MIME[ext] };
  }
  return null;
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Audio download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

/** Resolve the full audio file for a SoundCloud track id (downloads it once). */
export function getFullAudio(app, id, { dir = paths.audio() } = {}) {
  const hit = cachedAudio(id);
  if (hit) return Promise.resolve(hit);
  const key = `${dir}|${id}`;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const s = await app.sc.resolveStream(id);
    const ext = EXT(s.mime);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe(id)}.${ext}`);
    let parts;
    if (s.protocol === 'progressive') parts = [await fetchBuf(s.url)];
    else {
      const m3u8 = (await fetchBuf(s.url)).toString('utf8');
      const urls = [];
      for (const line of m3u8.split('\n')) {
        const l = line.trim();
        const map = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(l);
        if (map) urls.push(new URL(map[1], s.url).href);
        else if (l && !l.startsWith('#')) urls.push(new URL(l, s.url).href);
      }
      parts = new Array(urls.length);
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < urls.length) { const i = next++; parts[i] = await fetchBuf(urls[i]); }
      }));
    }
    fs.writeFileSync(file + '.part', Buffer.concat(parts));
    fs.renameSync(file + '.part', file);
    if (dir === paths.audio()) pruneAudio();
    return { file, mime: MIME[ext] };
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

function pruneAudio(keep = 30) {
  try {
    const files = fs.readdirSync(paths.audio()).map((f) => ({ f: path.join(paths.audio(), f), t: fs.statSync(path.join(paths.audio(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) fs.rmSync(x.f, { force: true });
  } catch { /* ignore */ }
}
