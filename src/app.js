// Wires config, LLM provider, SoundCloud client, library and curator together.
import { loadConfig } from './config.js';
import { createLLM } from './llm/index.js';
import { SoundCloud } from './soundcloud.js';
import { Library } from './library.js';
import { Curator } from './agent.js';

export class App {
  constructor() {
    this.library = new Library();
    this.reconfigure();
  }

  reconfigure() {
    this.cfg = loadConfig();
    const prevCache = this.sc?.trackCache;
    this.sc = new SoundCloud(this.cfg.soundcloud);
    if (prevCache) this.sc.trackCache = prevCache;
    try { this.llm = createLLM(this.cfg); this.llmError = null; }
    catch (e) { this.llm = null; this.llmError = e.message; }
    this.curator = new Curator({ llm: this.llm, soundcloud: this.sc, library: this.library });
    return this;
  }

  requireLLM() {
    if (!this.llm) throw new Error(this.llmError || 'No LLM configured');
    return this.llm;
  }

  async generate(prompt, opts) {
    this.requireLLM();
    return this.curator.generate(prompt, { lang: this.cfg.ui?.language, ...opts });
  }

  /** Domains the stream proxy may fetch from (keeps it from becoming an open proxy). */
  allowedStreamHost(hostname) {
    const extra = [this.cfg.soundcloud.apiBase, this.cfg.soundcloud.webBase].map((u) => { try { return new URL(u).hostname; } catch { return ''; } });
    return /(^|\.)(sndcdn\.com|soundcloud\.com|soundcloud\.cloud)$/.test(hostname) || extra.includes(hostname);
  }
}
