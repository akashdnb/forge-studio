const { setTimeout: sleep } = require('node:timers/promises');

class HttpJsonProvider {
  constructor({ name, endpoint, headers = {}, timeoutMs = 120000, maxAttempts = 2, buildBody = (request) => request, parse = (body) => body, fetchImpl = fetch } = {}) {
    if (!name || !endpoint) throw new TypeError('name and endpoint are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError('maxAttempts must be 1..5');
    this.name = name;
    this.endpoint = endpoint;
    this.headers = { ...headers };
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.buildBody = buildBody;
    this.parse = parse;
    this.fetchImpl = fetchImpl;
  }

  async execute(request) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const started = Date.now();
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers },
          body: JSON.stringify(this.buildBody(request)),
          signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error(`Provider ${this.name} returned invalid JSON`), { retryable: response.status >= 500 }); }
        if (!response.ok) {
          const error = new Error(`Provider ${this.name} returned HTTP ${response.status}`);
          error.status = response.status;
          error.providerBody = body;
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw error;
        }
        return this.parse(body, { latencyMs: Date.now() - started, attempt });
      } catch (error) {
        lastError = error.name === 'AbortError' ? Object.assign(new Error(`Provider ${this.name} timed out after ${this.timeoutMs}ms`), { retryable: true }) : error;
        if (!lastError.retryable || attempt >= this.maxAttempts) throw lastError;
        await sleep(Math.min(5000, 250 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function openAiCompatibleChatProvider({ name = 'openai-compatible', endpoint, apiKey, model, timeoutMs = 120000 } = {}) {
  if (!apiKey) throw new TypeError('apiKey is required');
  if (!model) throw new TypeError('model is required');
  return new HttpJsonProvider({
    name,
    endpoint,
    timeoutMs,
    headers: { authorization: `Bearer ${apiKey}` },
    buildBody: (request) => ({ model, messages: request.messages || [{ role: 'user', content: String(request.prompt || '') }], temperature: request.temperature ?? 0.2 }),
    parse: (body, meta) => ({
      artifacts: [{ kind: 'text', content: body.choices?.[0]?.message?.content || '', mediaType: 'text/plain', metadata: { provider: name, model } }],
      usage: body.usage || {}, estimatedCost: null, actualCost: null, currency: 'USD', metadata: meta,
    }),
  });
}

module.exports = { HttpJsonProvider, openAiCompatibleChatProvider };
