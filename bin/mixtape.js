#!/usr/bin/env node
import { App } from '../src/app.js';
import { createServer, listen, probe } from '../src/server.js';
import { CONFIG_PATH, DATA_DIR, loadConfig, publicConfig, setConfigValue } from '../src/config.js';
import { openBrowser } from '../src/util/open.js';
import { LIKED_ID } from '../src/library.js';
import { ensureDefaults, importMySongs, refreshForYou } from '../src/seed.js';

const [cmd = 'serve', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

const HELP = `mixtape — AI music player agent (SoundCloud + Claude)

Usage:
  mixtape serve [--port N] [--no-open]   Start the web player (default command)
  mixtape mcp                            Run as an MCP server (stdio) so Claude can drive it
  mixtape generate "<request>" [--play]  Curate a 15-track playlist from a mood/genre/description
  mixtape playlists                      List playlists (built-ins: "mine", "for-you", "liked")
  mixtape import-songs                   Re-match your song list (data/my-songs.json) on SoundCloud
  mixtape recommend                      Rebuild the "For You" recommendations
  mixtape show <playlist-id>             Show a playlist's tracks
  mixtape like <track-id> | unlike <track-id>
  mixtape config                         Show configuration (keys masked)
  mixtape config set <key> <value>       e.g. config set llm.provider anthropic
  mixtape doctor                         Check Claude CLI / API / SoundCloud connectivity

Add to Claude Code:
  claude mcp add mixtape -- node ${process.argv[1]} mcp

Data: ${DATA_DIR}`;

const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;
const printPlaylist = (p) => {
  console.log(`\n${p.title}  [${p.id}]  ${p.tracks.length} tracks${p.description ? `\n${p.description}` : ''}\n`);
  p.tracks.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.liked ? '♥' : ' '} ${t.artist} – ${t.title}  (${fmtDur(t.durationMs)})  id:${t.id}`));
};

async function serve() {
  const cfg = loadConfig();
  const port = Number(flagValue('--port')) || cfg.server.port;
  const base = `http://127.0.0.1:${port}`;
  if (await probe(base)) {
    console.log(`Mixtape is already running at ${base}`);
    if (!flags.has('--no-open')) openBrowser(base);
    return;
  }
  const app = new App();
  const server = createServer(app);
  const url = await listen(server, { host: cfg.server.host, port });
  console.log(`♪ Mixtape player running at ${url}`);
  console.log(`  LLM: ${app.llm ? app.llm.describe() : `not configured (${app.llmError})`}`);
  console.log('  Ctrl+C to stop.');
  if (!flags.has('--no-open') && !process.env.MIXTAPE_NO_BROWSER) openBrowser(url);
  ensureDefaults(app, (m) => console.log(`  ${m}`));
  return { app, server, url };
}

async function main() {
  switch (cmd) {
    case 'serve': case 'start': return serve();
    case 'import-songs': {
      const r = await importMySongs(new App(), { onProgress: (p) => console.error(`  ${p.message}`) });
      printPlaylist(r.playlist);
      if (r.missing.length) console.error(`\nNot found on SoundCloud: ${r.missing.join('; ')}`);
      return;
    }
    case 'recommend': case 'for-you': {
      const app = new App();
      if (!app.library.hasPlaylist('mine')) await importMySongs(app);
      return printPlaylist((await refreshForYou(app, { onProgress: (p) => console.error(`  · ${p.message}`) })).playlist);
    }
    case 'mcp': { const { runMcp } = await import('../src/mcp.js'); return runMcp(); }
    case 'generate': case 'gen': {
      const prompt = args.join(' ');
      if (!prompt) throw new Error('Usage: mixtape generate "<what you want to hear>"');
      const app = new App();
      const r = await app.generate(prompt, { onProgress: (p) => console.error(`  · ${p.message}`) });
      printPlaylist(r.playlist);
      r.warnings.forEach((w) => console.error(`warning: ${w}`));
      if (flags.has('--play')) {
        const cfg = loadConfig();
        const base = `http://127.0.0.1:${cfg.server.port}`;
        if (!(await probe(base))) {
          const server = createServer(app);
          await listen(server, cfg.server);
          console.log(`\nPlayer running at ${base} (Ctrl+C to stop)`);
        }
        openBrowser(`${base}/?play=${r.playlist.id}`);
      }
      return;
    }
    case 'playlists': case 'ls': {
      const app = new App();
      for (const p of app.library.listPlaylists()) console.log(`${p.id.padEnd(9)} ${p.title}  (${p.count})`);
      return;
    }
    case 'show': {
      const p = new App().library.getPlaylist(args[0] || LIKED_ID);
      if (!p) throw new Error('Playlist not found');
      return printPlaylist(p);
    }
    case 'liked': return printPlaylist(new App().library.getPlaylist(LIKED_ID));
    case 'like': case 'unlike': {
      if (!args[0]) throw new Error(`Usage: mixtape ${cmd} <track-id>`);
      const app = new App();
      let track = app.library.findTrack(args[0]);
      if (!track && cmd === 'like') track = await app.sc.getTrack(args[0]);
      app.library.setLiked(args[0], cmd === 'like', track);
      console.log(cmd === 'like' ? `♥ Added ${track.artist} – ${track.title} to Liked Songs` : 'Removed from Liked Songs');
      return;
    }
    case 'config': {
      if (args[0] === 'set') {
        if (args.length < 3) throw new Error('Usage: mixtape config set <key> <value>');
        setConfigValue(args[1], args.slice(2).join(' '));
        console.log(`Saved ${args[1]} to ${CONFIG_PATH}`);
        return;
      }
      if (args[0] === 'path') return console.log(CONFIG_PATH);
      return console.log(JSON.stringify(publicConfig(loadConfig()), null, 2));
    }
    case 'doctor': {
      const app = new App();
      console.log(`Config: ${CONFIG_PATH}`);
      if (!app.llm) console.log(`✗ LLM: ${app.llmError}`);
      else {
        process.stdout.write(`… LLM: ${app.llm.describe()} `);
        try { const t = Date.now(); const r = await app.llm.complete({ system: 'Reply with exactly: OK', prompt: 'Say OK' }); console.log(`✓ (${r.trim().slice(0, 20)}, ${Date.now() - t}ms)`); }
        catch (e) { console.log(`✗ ${e.message}`); }
      }
      process.stdout.write('… SoundCloud: ');
      try { const r = await app.sc.searchTracks('lofi hip hop', { limit: 10 }); console.log(`✓ search returned ${r.length} playable tracks`); }
      catch (e) { console.log(`✗ ${e.message}`); }
      return;
    }
    case 'help': case '--help': case '-h': return console.log(HELP);
    default: console.log(HELP); process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
