// Persistent library: generated playlists + the built-in "Liked Songs" collection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { storableTrack } from './soundcloud.js';

export const LIKED_ID = 'liked';
export const MINE_ID = 'mine';
export const FOR_YOU_ID = 'for-you';
export const INSPIRATIONS_ID = 'inspirations';
const BUILTIN_ORDER = [MINE_ID, FOR_YOU_ID, INSPIRATIONS_ID];
const INSPIRATIONS_DESC = 'Versions you saved in Creation Mode. Play them, or open them in Creation Mode to keep creating.';

export class Library {
  constructor(file = path.join(DATA_DIR, 'library.json')) {
    this.file = file;
    this.listeners = new Set();
    this.data = this.load();
  }

  mtime() { try { return fs.statSync(this.file).mtimeMs; } catch { return 0; } }

  /** Pick up writes made by another process (e.g. `mixtape generate` while the player is open). */
  refreshIfChanged() {
    const m = this.mtime();
    if (m && m !== this._mtime) { this.data = this.load(); return true; }
    return false;
  }

  load() {
    this._mtime = this.mtime();
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return this.withBuiltins({ playlists: d.playlists || [], liked: d.liked || [], ...(d.likedOrder ? { likedOrder: d.likedOrder } : {}) });
    } catch { return this.withBuiltins({ playlists: [], liked: [] }); }
  }

  /** "My Inspirations" always exists, even before the first saved creation. */
  withBuiltins(d) {
    if (!d.playlists.some((p) => p.id === INSPIRATIONS_ID)) d.playlists.push({ id: INSPIRATIONS_ID, builtin: true, title: 'My Inspirations', description: INSPIRATIONS_DESC, prompt: '', createdAt: new Date(0).toISOString(), tracks: [] });
    return d;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this._mtime = this.mtime();
    for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  likedIds() { return new Set(this.data.liked.map((e) => e.track.id)); }

  isLiked(trackId) { return this.data.liked.some((e) => e.track.id === String(trackId)); }

  findTrack(trackId) {
    const id = String(trackId);
    for (const e of this.data.liked) if (e.track.id === id) return e.track;
    for (const p of this.data.playlists) { const t = p.tracks.find((x) => x.id === id); if (t) return t; }
    return null;
  }

  /** Liked Songs as a regular-looking playlist, newest like first. */
  likedPlaylist() {
    return {
      id: LIKED_ID,
      builtin: true,
      title: 'Liked Songs',
      description: 'Every track you have hearted, newest first.',
      createdAt: null,
      tracks: this.orderedLiked().map((e) => ({ ...e.track, likedAt: e.likedAt })),
    };
  }

  /** Newest like first, unless you've arranged Liked Songs yourself (new likes still go on top). */
  orderedLiked() {
    const newest = [...this.data.liked].sort((a, b) => b.likedAt.localeCompare(a.likedAt));
    const order = this.data.likedOrder;
    if (!order?.length) return newest;
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...newest.filter((e) => !pos.has(e.track.id)), ...newest.filter((e) => pos.has(e.track.id)).sort((a, b) => pos.get(a.track.id) - pos.get(b.track.id))];
  }

  /** Put a playlist's songs in a new order (drag and drop). Unknown ids are ignored; missing ones keep their place at the end. */
  reorder(playlistId, ids) {
    ids = (ids || []).map(String);
    if (playlistId === LIKED_ID) {
      const have = new Set(this.data.liked.map((e) => e.track.id));
      this.data.likedOrder = [...new Set(ids.filter((id) => have.has(id)))];
      this.save();
      return this.getPlaylist(LIKED_ID);
    }
    const p = this.data.playlists.find((x) => x.id === playlistId);
    if (!p) throw new Error('Playlist not found');
    const byId = new Map(p.tracks.map((t) => [t.id, t]));
    const next = [...new Set(ids)].filter((id) => byId.has(id)).map((id) => byId.get(id));
    const placed = new Set(next.map((t) => t.id));
    p.tracks = [...next, ...p.tracks.filter((t) => !placed.has(t.id))];
    this.save();
    return this.getPlaylist(playlistId);
  }

  /** A version saved in Creation Mode: newest first in My Inspirations. */
  addInspiration(track) {
    const p = this.data.playlists.find((x) => x.id === INSPIRATIONS_ID);
    p.tracks = [{ ...track, id: String(track.id) }, ...p.tracks.filter((t) => t.id !== String(track.id))];
    this.save();
    return track;
  }

  listPlaylists() {
    const liked = this.likedPlaylist();
    return [
      { id: liked.id, builtin: true, title: liked.title, count: liked.tracks.length, artwork: liked.tracks[0]?.artwork || '' },
      ...[...this.data.playlists].sort((a, b) => {
        const ra = BUILTIN_ORDER.indexOf(a.id), rb = BUILTIN_ORDER.indexOf(b.id);
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
        return b.createdAt.localeCompare(a.createdAt);
      }).map((p) => ({
        id: p.id, builtin: !!p.builtin, title: p.title, description: p.description, prompt: p.prompt, createdAt: p.createdAt,
        count: p.tracks.length, artwork: p.tracks.find((t) => t.artwork)?.artwork || '',
      })),
    ];
  }

  getPlaylist(id) {
    if (id === LIKED_ID) return this.withLikes(this.likedPlaylist());
    const p = this.data.playlists.find((x) => x.id === id);
    return p ? this.withLikes(structuredClone(p)) : null;
  }

  withLikes(p) {
    const liked = this.likedIds();
    p.tracks = p.tracks.map((t) => ({ ...t, liked: liked.has(t.id) }));
    return p;
  }

  createPlaylist({ title, description = '', prompt = '', tracks, notes = {} }) {
    const p = {
      id: crypto.randomUUID().slice(0, 8),
      title: title || 'Untitled mix',
      description,
      prompt,
      createdAt: new Date().toISOString(),
      tracks: tracks.map((t) => ({ ...storableTrack(t), ...(notes[t.id] ? { note: notes[t.id] } : {}) })),
    };
    this.data.playlists.push(p);
    this.save();
    return this.getPlaylist(p.id);
  }

  hasPlaylist(id) { return this.data.playlists.some((p) => p.id === id); }

  /** Create or replace a playlist with a fixed id (used for built-ins like My Songs / For You). */
  upsertPlaylist({ id, builtin = false, title, description = '', prompt = '', tracks, notes = {}, meta }) {
    const p = {
      id, builtin, title, description, prompt,
      createdAt: new Date().toISOString(),
      tracks: tracks.map((t) => ({ ...storableTrack(t), ...(notes[t.id] ? { note: notes[t.id] } : {}) })),
      ...(meta ? { meta } : {}),
    };
    const i = this.data.playlists.findIndex((x) => x.id === id);
    if (i >= 0) this.data.playlists[i] = p; else this.data.playlists.push(p);
    this.save();
    return this.getPlaylist(id);
  }

  renamePlaylist(id, title) {
    const p = this.data.playlists.find((x) => x.id === id);
    if (!p) throw new Error('Playlist not found');
    p.title = String(title).slice(0, 120);
    this.save();
    return this.getPlaylist(id);
  }

  deletePlaylist(id) {
    if (id === LIKED_ID || BUILTIN_ORDER.includes(id)) throw new Error('Built-in playlists cannot be deleted');
    const before = this.data.playlists.length;
    this.data.playlists = this.data.playlists.filter((p) => p.id !== id);
    if (this.data.playlists.length === before) throw new Error('Playlist not found');
    this.save();
  }

  /** Add a track (e.g. from search) to a playlist; no duplicates. Returns false if it was already there. */
  addTrack(playlistId, track) {
    if (playlistId === LIKED_ID) { this.setLiked(track.id, true, track); return true; }
    if (BUILTIN_ORDER.includes(playlistId)) throw new Error('Built-in playlists are managed automatically');
    const p = this.data.playlists.find((x) => x.id === playlistId);
    if (!p) throw new Error('Playlist not found');
    if (p.tracks.some((t) => t.id === String(track.id))) return false;
    const { liked: _l, offline: _o, ...clean } = storableTrack({ ...track, id: String(track.id) });
    p.tracks.push(clean);
    this.save();
    return true;
  }

  removeTrack(playlistId, trackId) {
    if (playlistId === LIKED_ID) return this.setLiked(trackId, false);
    const p = this.data.playlists.find((x) => x.id === playlistId);
    if (!p) throw new Error('Playlist not found');
    p.tracks = p.tracks.filter((t) => t.id !== String(trackId));
    this.save();
    return true;
  }

  /** Favorite / unfavorite. `track` metadata is needed when liking a track not yet in the library. */
  setLiked(trackId, liked, track = null) {
    const id = String(trackId);
    const has = this.isLiked(id);
    if (liked && !has) {
      const meta = track || this.findTrack(id);
      if (!meta) throw new Error(`Unknown track ${id}; pass its metadata to like it`);
      const { liked: _l, likedAt: _a, note: _n, ...clean } = storableTrack({ ...meta, id });
      this.data.liked.push({ track: clean, likedAt: new Date().toISOString() });
      this.save();
    } else if (!liked && has) {
      this.data.liked = this.data.liked.filter((e) => e.track.id !== id);
      this.save();
    }
    return liked;
  }

  toggleLiked(trackId, track) { return this.setLiked(trackId, !this.isLiked(trackId), track); }

  /** Compact taste profile from liked songs, used to personalise curation. */
  tasteSummary(max = 25) {
    const mine = this.data.playlists.find((p) => p.id === MINE_ID)?.tracks || [];
    const seen = new Set();
    const liked = [...this.likedPlaylist().tracks, ...mine].filter((t) => !t.local && !seen.has(t.id) && seen.add(t.id)).slice(0, max);
    if (!liked.length) return '';
    return liked.map((t) => `${t.artist} – ${t.title}${t.genre ? ` [${t.genre}]` : ''}`).join('\n');
  }
}
