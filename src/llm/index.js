// LLM provider abstraction. Every provider exposes: complete({ system, prompt }) -> string
import { ClaudeCliProvider } from './claudeCli.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';

export function createLLM(cfg) {
  const p = cfg.llm.provider;
  if (p === 'claude-cli') return new ClaudeCliProvider(cfg.llm.claudeCli);
  if (p === 'anthropic') return new AnthropicProvider(cfg.llm.anthropic);
  if (p === 'openai') return new OpenAICompatProvider(cfg.llm.openai);
  throw new Error(`Unknown llm.provider "${p}". Use claude-cli, anthropic or openai.`);
}

/** Pull the first JSON object/array out of an LLM response (tolerates ```json fences and chatter). */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('LLM returned no text');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* try balanced scan */ }
    const start = c.search(/[{[]/);
    if (start < 0) continue;
    const open = c[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error('Could not parse JSON from LLM response: ' + text.slice(0, 200));
}

export async function completeJson(llm, { system, prompt }, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await llm.complete({
      system,
      prompt: attempt === 0 ? prompt : prompt + '\n\nIMPORTANT: Your previous reply was not valid JSON. Reply with ONLY the JSON object.',
    });
    try { return extractJson(text); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
