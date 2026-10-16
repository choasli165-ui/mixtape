// Configuration: ~/.mixtape-agent/config.json, overridable by environment variables.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.MIXTAPE_HOME || path.join(os.homedir(), '.mixtape-agent');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const PLAYLIST_SIZE = 15;

export const DEFAULTS = {
  server: { host: '127.0.0.1', port: 4321 },
  ui: { language: '' }, // '', 'en', 'zh', 'ja'
  llm: {
    // "claude-cli" (default) | "anthropic" | "openai" (any OpenAI-compatible endpoint)
    provider: 'claude-cli',
    claudeCli: {
      command: 'claude',
      model: '',            // e.g. "sonnet", "opus", "haiku"; empty = Claude CLI default
      extraArgs: [],
      timeoutMs: 180000,
    },
    anthropic: {
      apiKey: '',           // or ANTHROPIC_API_KEY
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://api.anthropic.com',
      maxTokens: 4096,
    },
    openai: {
      apiKey: '',           // or OPENAI_API_KEY / MIXTAPE_LLM_API_KEY
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1', // Ollama: http://localhost:11434/v1, OpenRouter, Groq, etc.
      maxTokens: 4096,
    },
  },
  soundcloud: {
    clientId: '',           // optional; auto-discovered from soundcloud.com if empty
    apiBase: 'https://api-v2.soundcloud.com',
    webBase: 'https://soundcloud.com',
    minDurationSec: 75,
    maxDurationSec: 900,
  },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function readFileConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

export function loadConfig() {
  const cfg = deepMerge(DEFAULTS, readFileConfig());
  const env = process.env;
  if (env.MIXTAPE_PORT) cfg.server.port = Number(env.MIXTAPE_PORT);
  if (env.MIXTAPE_HOST) cfg.server.host = env.MIXTAPE_HOST;
  if (env.MIXTAPE_LLM_PROVIDER) cfg.llm.provider = env.MIXTAPE_LLM_PROVIDER;
  if (env.MIXTAPE_LLM_MODEL) cfg.llm[cfg.llm.provider === 'claude-cli' ? 'claudeCli' : cfg.llm.provider].model = env.MIXTAPE_LLM_MODEL;
  if (env.MIXTAPE_LLM_BASE_URL && cfg.llm[cfg.llm.provider]) cfg.llm[cfg.llm.provider].baseUrl = env.MIXTAPE_LLM_BASE_URL;
  if (env.ANTHROPIC_API_KEY && !cfg.llm.anthropic.apiKey) cfg.llm.anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY && !cfg.llm.openai.apiKey) cfg.llm.openai.apiKey = env.OPENAI_API_KEY;
  if (env.MIXTAPE_LLM_API_KEY) {
    if (cfg.llm.provider === 'anthropic') cfg.llm.anthropic.apiKey = env.MIXTAPE_LLM_API_KEY;
    if (cfg.llm.provider === 'openai') cfg.llm.openai.apiKey = env.MIXTAPE_LLM_API_KEY;
  }
  if (env.SOUNDCLOUD_CLIENT_ID) cfg.soundcloud.clientId = env.SOUNDCLOUD_CLIENT_ID;
  if (env.MIXTAPE_SC_API_BASE) cfg.soundcloud.apiBase = env.MIXTAPE_SC_API_BASE;
  if (env.MIXTAPE_SC_WEB_BASE) cfg.soundcloud.webBase = env.MIXTAPE_SC_WEB_BASE;
  return cfg;
}

/** Persist a partial config (merged into the file, not the env-derived values). */
export function saveConfig(partial) {
  const next = deepMerge(readFileConfig(), partial);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  return loadConfig();
}

/** Set a dotted key, e.g. setConfigValue('llm.provider', 'anthropic'). */
export function setConfigValue(key, rawValue) {
  let value = rawValue;
  try { value = JSON.parse(rawValue); } catch { /* keep string */ }
  const partial = {};
  const parts = key.split('.');
  let cur = partial;
  parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? value : {}; cur = cur[p]; });
  return saveConfig(partial);
}

function mask(key) { return key ? `${key.slice(0, 4)}…${key.slice(-4)}` : ''; }

/** Config safe to show in UI / logs (API keys masked). */
export function publicConfig(cfg) {
  const c = structuredClone(cfg);
  c.llm.anthropic.hasKey = !!c.llm.anthropic.apiKey;
  c.llm.openai.hasKey = !!c.llm.openai.apiKey;
  c.llm.anthropic.apiKey = mask(c.llm.anthropic.apiKey);
  c.llm.openai.apiKey = mask(c.llm.openai.apiKey);
  c.soundcloud.clientId = c.soundcloud.clientId ? mask(c.soundcloud.clientId) : '';
  return c;
}
