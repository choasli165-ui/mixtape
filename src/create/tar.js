// Minimal .tgz extractor (npm package tarballs): ustar + pax path records.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const str = (b, s, l) => b.toString('utf8', s, s + l).replace(/\0.*$/s, '');

/** Extract a gzipped tarball buffer into `dest`, removing `strip` leading path components. */
export function extractTgz(tgz, dest, { strip = 1 } = {}) {
  const buf = zlib.gunzipSync(tgz);
  let off = 0, paxPath = null, written = 0;
  const root = path.resolve(dest);
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    let name = paxPath || (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { // pax extended header for the next entry
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'L') { paxPath = body.toString('utf8').replace(/\0.*$/s, ''); continue; } // GNU long name
    if (type === 'g') continue;
    paxPath = null;
    const parts = name.split('/').filter(Boolean).slice(strip);
    if (!parts.length) continue;
    const target = path.resolve(root, ...parts);
    if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${name}`);
    if (type === '5') { fs.mkdirSync(target, { recursive: true }); continue; }
    if (type !== '0' && type !== '\0' && type !== '7') continue; // skip links etc.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    written++;
  }
  return written;
}
