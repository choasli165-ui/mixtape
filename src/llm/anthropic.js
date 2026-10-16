// Anthropic Messages API provider.
export class AnthropicProvider {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || 'claude-sonnet-5-5';
    // accept the base URL, …/v1 or the full …/v1/messages endpoint
    this.baseUrl = (opts.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '');
    this.maxTokens = opts.maxTokens || 4096;
    this.name = 'anthropic';
  }

  describe() { let host = this.baseUrl; try { host = new URL(this.baseUrl).host; } catch {} return `Custom API (${this.model} @ ${host})`; }

  async complete({ system, prompt }) {
    if (!this.apiKey && /api\.anthropic\.com/.test(this.baseUrl)) throw new Error('Anthropic API key missing. Set ANTHROPIC_API_KEY or `mixtape config set llm.anthropic.apiKey <key>`.');
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
    return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
}
