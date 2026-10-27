const { ProviderReliability } = require('../reliability/provider-reliability');

class HttpJsonProvider {
  constructor({ name, endpoint, headers = {}, timeoutMs = 120000, maxAttempts = 3, buildBody = (request) => request, parse = (body) => body, fetchImpl = fetch, reliability = null, policy = {}, fallbacks = [] } = {}) {
    if (!name || !endpoint) throw new TypeError('name and endpoint are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    this.name = name; this.endpoint = endpoint; this.headers = { ...headers }; this.timeoutMs = timeoutMs; this.maxAttempts = maxAttempts; this.buildBody = buildBody; this.parse = parse; this.fetchImpl = fetchImpl; this.reliability = reliability || new ProviderReliability(); this.policy = { timeoutMs, maxAttempts, ...policy }; this.fallbacks = fallbacks;
  }

  async execute(request, context = {}) {
    const call = async (provider, signal, attempt) => {
      const started = Date.now();
      const response = await this.fetchImpl(provider.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...provider.headers }, body: JSON.stringify(provider.buildBody(request)), signal });
      const text = await response.text(); let body = null;
      if (text) { try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`Provider ${provider.name} returned invalid JSON`), { code: 'MALFORMED_PROVIDER_RESPONSE', status: response.status }); } }
      if (!response.ok) { const error = new Error(`Provider ${provider.name} returned HTTP ${response.status}`); error.status = response.status; error.retryAfter = response.headers?.get?.('retry-after'); error.providerBody = body; throw error; }
      return provider.parse(body, { latencyMs: Date.now() - started, attempt });
    };
    const provider = { ...this, execute: undefined };
    if (context.__reliabilityManaged || context.attempt) return call(provider, context.signal, context.attempt || 1);
    return (await this.reliability.execute({ provider: { ...provider, execute: (req, ctx) => call(provider, ctx.signal, ctx.attempt) }, operation: context.operation || 'http', request, context: { ...context, idempotencyKey: context.idempotencyKey }, policy: this.policy, fallbacks: this.fallbacks, contract: { idempotent: this.idempotent !== false, allowFailover: this.allowFailover === true, contractCompatible: this.contractCompatible !== false } })).result;
  }
}

function openAiCompatibleChatProvider({ name = 'openai-compatible', endpoint, apiKey, model, timeoutMs = 120000, reliability = null, fallbacks = [] } = {}) {
  if (!apiKey) throw new TypeError('apiKey is required'); if (!model) throw new TypeError('model is required');
  return new HttpJsonProvider({ name, endpoint, timeoutMs, reliability, fallbacks, headers: { authorization: `Bearer ${apiKey}` }, buildBody: (request) => ({ model, messages: request.messages || [{ role: 'user', content: String(request.prompt || '') }], temperature: request.temperature ?? 0.2 }), parse: (body, meta) => ({ artifacts: [{ kind: 'text', content: body.choices?.[0]?.message?.content || '', mediaType: 'text/plain', metadata: { provider: name, model } }], usage: body.usage || {}, estimatedCost: null, actualCost: null, currency: 'USD', metadata: meta }) });
}

module.exports = { HttpJsonProvider, openAiCompatibleChatProvider };
