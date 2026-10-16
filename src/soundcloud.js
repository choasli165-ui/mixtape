// SoundCloud client: track search and stream resolution via the public api-v2 endpoints.
// A client_id is required; if none is configured it is discovered from soundcloud.com's web bundle
// (the same id the SoundCloud website uses) and cached on disk.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CACHE_PATH = path.join(DATA_DIR, 'soundcloud-client-id.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';

export class SoundCloud {
  constructor(opts = {}) {
    this.apiBase = (opts.apiBase || 'https://api-v2.soundcloud.com').replace(/\/$/, '');
    this.webBase = (opts.webBase || 'https://soundcloud.com').replace(/\/$/, '');
    this.configuredClientId = opts.clientId || '';
    this.minDurationSec = opts.minDurationSec ?? 75;
    this.maxDurationSec = opts.maxDurationSec ?? 900;
    this.clientId = this.configuredClientId || readCachedId();
    this._discovering = null;
    this.trackCache = new Map();
  }

  async getClientId(force = false) {
    if (this.clientId && !force) return this.clientId;
    if (this.configuredClientId && !force) return this.configuredClientId;
    this._discovering ??= this.discoverClientId().finally(() => { this._discovering = null; });
    this.clientId = await this._discovering;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CACHE_PATH, JSON.stringify({ clientId: this.clientId, at: Date.now() })); } catch { /* non-fatal */ }
    return this.clientId;
  }

  async discoverClientId() {
    const html = await (await fetchOk(this.webBase + '/', { headers: { 'user-agent': UA } })).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], this.webBase + '/').href);
    // The client_id lives in one of the later app bundles; scan from the end.
    for (const src of scripts.reverse()) {
      try {
        const js = await (await fetchOk(src, { headers: { 'user-agent': UA } })).text();
        const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
        if (m) return m[1];
      } catch { /* try next bundle */ }
    }
    throw new Error('Could not discover a SoundCloud client_id. Set one with: mixtape config set soundcloud.clientId <id>');
  }

  /** GET an api-v2 path with client_id; refreshes a stale id once on 401/403. */
  async api(pathname, params = {}, retry = true) {
    const clientId = await this.getClientId();
    const url = new URL(this.apiBase + pathname);
    for (const [k, v] of Object.entries({ ...params, client_id: clientId })) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if ((res.status === 401 || res.status === 403) && retry && !this.configuredClientId) {
      await this.getClientId(true);
      return this.api(pathname, params, false);
    }
    if (!res.ok) throw new Error(`SoundCloud ${res.status} on ${pathname}`);
    return res.json();
  }

  /** Search tracks; returns normalized, playable tracks only. */
  async searchTracks(query, { limit = 40 } = {}) {
    const data = await this.api('/search/tracks', { q: query, limit, offset: 0, linked_partitioning: 1 });
    return (data.collection || []).map(normalizeTrack).filter((t) => this.isUsable(t)).map((t) => this.remember(t));
  }

  isUsable(t) {
    if (!t || !t.id || t.policy === 'BLOCK' || t.streamable === false) return false;
    if (t.isPreview) return false; // 30-second snippets
    if (!t.transcodings.length) return false;
    const s = t.durationMs / 1000;
    return s >= this.minDurationSec && s <= this.maxDurationSec;
  }

  remember(t) { this.trackCache.set(String(t.id), t); return t; }

  async getTrack(id) {
    const raw = await this.api(`/tracks/${encodeURIComponent(id)}`);
    return this.remember(normalizeTrack(raw));
  }

  async getTracks(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const raw = await this.api('/tracks', { ids: ids.slice(i, i + 50).join(',') });
      out.push(...(Array.isArray(raw) ? raw : raw.collection || []).map(normalizeTrack).map((t) => this.remember(t)));
    }
    return out;
  }

  /** An uploader's public profile. */
  async getUser(id) {
    const u = await this.api(`/users/${encodeURIComponent(id)}`);
    return {
      id: String(u.id), username: u.username || '', fullName: u.full_name || '', avatar: bigArt(u.avatar_url || ''), url: u.permalink_url || '',
      city: u.city || '', country: u.country_code || '', followers: u.followers_count ?? 0, trackCount: u.track_count ?? 0, verified: !!u.verified,
      description: String(u.description || '').slice(0, 600),
    };
  }

  /** An uploader's playable tracks, newest first. */
  async userTracks(id, { limit = 50 } = {}) {
    const data = await this.api(`/users/${encodeURIComponent(id)}/tracks`, { limit, offset: 0, linked_partitioning: 1 });
    return (data.collection || []).map(normalizeTrack).filter((t) => this.isUsable(t)).map((t) => this.remember(t));
  }

  /** Resolve a fresh playable stream URL for a track. */
  async resolveStream(id) {
    const t = await this.getTrack(id); // fresh transcodings + track_authorization (they expire)
    const order = [
      (x) => x.protocol === 'progressive' && /mpeg/.test(x.mime),
      (x) => x.protocol === 'progressive',
      (x) => x.protocol === 'hls' && /mpeg/.test(x.mime),
      (x) => x.protocol === 'hls' && /mp4|aac/.test(x.mime),
      (x) => x.protocol === 'hls',
    ];
    const sorted = order.map((f) => t.transcodings.find((x) => f(x) && !x.snipped)).filter(Boolean);
    let lastErr;
    for (const tc of sorted) {
      try {
        const data = await this.api(new URL(tc.url).pathname, { track_authorization: t.trackAuthorization });
        if (data?.url) return { protocol: tc.protocol, mime: tc.mime, url: data.url, track: t };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No playable stream for this track');
  }
}

function readCachedId() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - c.at < 7 * 864e5) return c.clientId;
  } catch { /* none */ }
  return '';
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

function bigArt(url) { return url ? url.replace('-large.', '-t500x500.') : ''; }

export function normalizeTrack(raw) {
  if (!raw || raw.kind && raw.kind !== 'track') return null;
  const durationMs = raw.full_duration || raw.duration || 0;
  const transcodings = (raw.media?.transcodings || []).map((x) => ({
    url: x.url,
    protocol: x.format?.protocol,
    mime: x.format?.mime_type || '',
    snipped: !!x.snipped,
  }));
  return {
    id: String(raw.id),
    title: raw.title || 'Untitled',
    artist: raw.publisher_metadata?.artist || raw.user?.username || 'Unknown artist',
    uploader: raw.user?.username || '',
    userId: raw.user?.id != null ? String(raw.user.id) : (raw.user_id != null ? String(raw.user_id) : ''), // the uploader's unique SoundCloud id
    userUrl: raw.user?.permalink_url || '',
    artwork: bigArt(raw.artwork_url || raw.user?.avatar_url || ''),
    permalinkUrl: raw.permalink_url || '',
    durationMs,
    genre: raw.genre || '',
    tags: parseTags(raw.tag_list),
    plays: raw.playback_count ?? 0,
    likes: raw.likes_count ?? raw.favoritings_count ?? 0,
    createdAt: raw.created_at || raw.display_date || '',
    policy: raw.policy || '',
    streamable: raw.streamable !== false,
    isPreview: raw.policy === 'SNIP' || (raw.duration && raw.full_duration && raw.duration < raw.full_duration - 1000) || transcodings.length > 0 && transcodings.every((x) => x.snipped),
    transcodings,
    trackAuthorization: raw.track_authorization || '',
  };
}

function parseTags(tagList = '') {
  return [...String(tagList).matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] || m[2]).slice(0, 8);
}

/** Strip transient/bulky fields before persisting a track in the library. */
export function storableTrack(t) {
  const { transcodings, trackAuthorization, policy, streamable, isPreview, ...rest } = t;
  return rest;
}
