// Mock SoundCloud (web + api-v2 + CDN) and a mock OpenAI-compatible LLM, all on one local server.
import http from 'node:http';

export const CLIENT_ID = 'abcdefghijklmnopqrstuvwxyz123456';
const ARTISTS = ['Nova Lane', 'Kiko Bay', 'Satin Dusk', 'Ores', 'Mono Hearts', 'Lumen Field', 'Tape Ghost', 'Velvet Static', 'Aria Kei', 'Low Orbit'];

function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

function rawTrack(id, base, i, q) {
  const artist = ARTISTS[(hash(q) + i) % ARTISTS.length];
  const snip = i === 3, blocked = i === 4;
  return {
    kind: 'track', id, title: `${q} song ${i}`, duration: snip ? 30000 : 200000 + i * 1000, full_duration: 200000 + i * 1000,
    genre: q.split(' ')[0], tag_list: `chill "late night" ${q.split(' ')[0]}`, playback_count: 100000 - i * 1000, likes_count: 500,
    permalink_url: `https://soundcloud.com/${artist.replace(/ /g, '').toLowerCase()}/track-${id}`,
    artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`, policy: blocked ? 'BLOCK' : snip ? 'SNIP' : 'ALLOW', streamable: true,
    user: { id: 1000 + ARTISTS.indexOf(artist), username: artist, avatar_url: '', permalink_url: `https://soundcloud.com/${artist.replace(/ /g, '').toLowerCase()}` }, track_authorization: 'auth-' + id,
    media: { transcodings: [
      { url: `${base}/media/soundcloud:tracks:${id}/x/stream/hls`, format: { protocol: 'hls', mime_type: i === 5 ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/mpeg' }, snipped: snip },
      // track #5 of every search is HLS-only (like many current SoundCloud uploads)
      ...(i === 5 ? [] : [{ url: `${base}/media/soundcloud:tracks:${id}/y/stream/progressive`, format: { protocol: 'progressive', mime_type: 'audio/mpeg' }, snipped: snip }]),
    ] },
  };
}

export function startMock() {
  const tracks = new Map();
  const calls = { search: 0, llm: 0, prompts: [] };
  const AUDIO = Buffer.alloc(4096, 0xff);
  let base;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (code, d) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    const p = url.pathname;
    let m0;
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><script crossorigin src="${base}/assets/vendor.js"></script><script crossorigin src="${base}/assets/app.js"></script></html>`); }
    if (p === '/assets/vendor.js') return res.end('var x=1;');
    if (p === '/assets/app.js') return res.end(`({client_id:"${CLIENT_ID}",foo:1})`);
    if (p.startsWith('/search') || p.startsWith('/tracks') || p.startsWith('/media') || p.startsWith('/users')) {
      if (url.searchParams.get('client_id') !== CLIENT_ID) return json(401, { error: 'bad client' });
    }
    if (p === '/search/tracks') {
      calls.search++;
      const q = url.searchParams.get('q');
      const coll = Array.from({ length: 25 }, (_, i) => { const id = (hash(q) % 100000) * 100 + i; const t = rawTrack(id, base, i, q); tracks.set(String(id), t); return t; });
      return json(200, { collection: coll });
    }
    if ((m0 = p.match(/^\/users\/(\d+)(\/tracks)?$/))) {
      const artist = ARTISTS[Number(m0[1]) - 1000];
      if (!artist) return json(404, {});
      if (!m0[2]) return json(200, { id: Number(m0[1]), username: artist, avatar_url: '', permalink_url: `https://soundcloud.com/${artist.replace(/ /g, '').toLowerCase()}`, followers_count: 1234, track_count: 6 });
      if (artist === 'Low Orbit') return json(200, { collection: [] }); // an uploader without public tracks
      const coll = Array.from({ length: 6 }, (_, i) => {
        const id = 9000000 + Number(m0[1]) * 10 + i;
        const t = { ...rawTrack(id, base, i === 3 || i === 4 ? 0 : i, `${artist} original`), title: `${artist} original ${i}` };
        t.user = { id: Number(m0[1]), username: artist, avatar_url: '', permalink_url: `https://soundcloud.com/${artist.replace(/ /g, '').toLowerCase()}` };
        tracks.set(String(id), t); return t;
      });
      return json(200, { collection: coll });
    }
    if (p === '/tracks') return json(200, url.searchParams.get('ids').split(',').map((id) => tracks.get(id)).filter(Boolean));
    let m;
    if ((m = p.match(/^\/tracks\/(\d+)$/))) return tracks.get(m[1]) ? json(200, tracks.get(m[1])) : json(404, {});
    if ((m = p.match(/^\/media\/soundcloud:tracks:(\d+)\/\w+\/stream\/(hls|progressive)$/))) {
      if (url.searchParams.get('track_authorization') !== 'auth-' + m[1]) return json(403, {});
      return json(200, { url: m[2] === 'hls' ? `${base}/cdn/${m[1]}/playlist.m3u8` : `${base}/cdn/${m[1]}.mp3` });
    }
    if ((m = p.match(/^\/cdn\/(\d+)\.mp3$/))) {
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const s = +range[1], e = range[2] ? +range[2] : AUDIO.length - 1;
        res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes ${s}-${e}/${AUDIO.length}`, 'content-length': e - s + 1 });
        return res.end(AUDIO.subarray(s, e + 1));
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.length }); return res.end(AUDIO);
    }
    if ((m = p.match(/^\/cdn\/(\d+)\/(seg\d|init)\.(mp3|mp4)$/))) { res.writeHead(200, { 'content-type': 'audio/mp4' }); return res.end(Buffer.from('SEG:' + m[2])); }
    if ((m = p.match(/^\/cdn\/(\d+)\/playlist\.m3u8$/))) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nseg0.mp3\n#EXTINF:10,\n${base}/cdn/${m[1]}/seg1.mp3\n#EXT-X-ENDLIST\n`);
    }
    // ---- mock OpenAI-compatible LLM
    if (p === '/v1/chat/completions') {
      calls.llm++;
      let body = ''; for await (const c of req) body += c;
      const { messages } = JSON.parse(body);
      const prompt = messages.at(-1).content;
      calls.prompts.push(prompt);
      let content;
      if (prompt.includes('Design SoundCloud search queries')) {
        content = 'Sure! Here is the plan:\n```json\n' + JSON.stringify({ title: 'Neon Rain', description: 'Moody late-night synths.', queries: ['darkwave', 'synthwave night drive', 'retrowave chill', 'darkwave'] }) + '\n```';
      } else {
        const ids = [...prompt.matchAll(/^(\d+) \|/gm)].map((x) => x[1]);
        content = JSON.stringify({ title: 'Neon Rain (Final)', description: 'Refined.', tracks: [{ id: '999999999', why: 'bogus' }, ...ids.slice(0, 16).map((id) => ({ id, why: `fits ${id}` }))] });
      }
      return json(200, { choices: [{ message: { role: 'assistant', content } }] });
    }
    json(404, { error: 'mock 404 ' + p });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, base, calls, tracks, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
