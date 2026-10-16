// Liked songs are downloaded automatically and played from disk; unliking removes the download.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './create/engine.js';
import { cachedAudio, getFullAudio } from './create/audio.js';

export class OfflineSync {
  constructor(app, notify = () => {}) {
    this.app = app; this.notify = notify;
    this.queue = []; this.active = new Set(); this.errors = new Map();
    this.timer = null;
  }

  dir() { return paths.offline(); }
  has(id) { return !!cachedAudio(id, [this.dir()]); }
  file(id) { return cachedAudio(id, [this.dir()]); }

  /** Called whenever likes may have changed. Debounced. */
  schedule(delay = 300) { clearTimeout(this.timer); this.timer = setTimeout(() => this.sync().catch(() => {}), delay); }

  async sync() {
    const liked = this.app.library.likedIds();
    // remove downloads of songs that are no longer liked
    let files = [];
    try { files = fs.readdirSync(this.dir()); } catch { /* none yet */ }
    for (const f of files) {
      const id = f.replace(/\.(mp3|ogg|m4a)(\.part)?$/, '');
      if (!liked.has(id) && !this.active.has(id)) { fs.rmSync(path.join(this.dir(), f), { force: true }); this.notify({ id, state: 'removed' }); }
    }
    for (const id of liked) {
      if (this.has(id) || this.active.has(id) || this.queue.includes(id)) continue;
      if (cachedAudio(id, [paths.inspirations()])) continue; // your own creations are already on this PC
      // reuse a copy Creation Mode already downloaded
      const tmp = cachedAudio(id, [paths.audio()]);
      if (tmp) {
        fs.mkdirSync(this.dir(), { recursive: true });
        fs.copyFileSync(tmp.file, path.join(this.dir(), path.basename(tmp.file)));
        this.notify({ id, state: 'saved' });
        continue;
      }
      this.queue.push(id);
    }
    this.pump();
    return this.status();
  }

  pump() {
    while (this.active.size < 2 && this.queue.length) {
      const id = this.queue.shift();
      if (!this.app.library.isLiked(id)) continue;
      this.active.add(id);
      this.notify({ id, state: 'downloading' });
      getFullAudio(this.app, id, { dir: this.dir() })
        .then(() => { this.errors.delete(id); this.notify({ id, state: this.app.library.isLiked(id) ? 'saved' : 'removed' }); })
        .catch((e) => { this.errors.set(id, e.message); this.notify({ id, state: 'error', error: e.message }); })
        .finally(() => {
          this.active.delete(id);
          if (!this.app.library.isLiked(id)) { const f = this.file(id); if (f) fs.rmSync(f.file, { force: true }); }
          this.pump();
        });
    }
  }

  status() {
    const liked = [...this.app.library.likedIds()];
    let bytes = 0, saved = 0;
    for (const id of liked) { const f = this.file(id); if (f) { saved++; try { bytes += fs.statSync(f.file).size; } catch {} } }
    return { liked: liked.length, saved, downloading: [...this.active], queued: this.queue.length, failed: Object.fromEntries(this.errors), megabytes: Math.round(bytes / 1e5) / 10 };
  }
}
