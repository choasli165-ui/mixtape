// OpenAI-compatible Chat Completions provider (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM…).
export class OpenAICompatProvider {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    // accept either the base URL or the full endpoint (…/chat/completions)
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    this.maxTokens = opts.maxTokens || 4096;
    this.name = 'openai';
  }

  describe() { let host = this.baseUrl; try { host = new URL(this.baseUrl).host; } catch {} return `Custom API (${this.model} @ ${host})`; }

  async complete({ system, prompt }) {
    if (!this.model) throw new Error('llm.openai.model is not set.');
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.7,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
    return body.choices?.[0]?.message?.content ?? '';
  }
}
