const { setTimeout: sleep } = require('node:timers/promises');
const { FailureInjector } = require('../chaos/failure-injector');
const { getActiveObservability, getCurrentTraceContext, traceparent } = require('../observability');
const { ProviderReliability } = require('../reliability/provider-reliability');

class HttpJsonProvider {
  constructor({ name, endpoint, headers = {}, timeoutMs = 120000, maxAttempts = 2, buildBody = (request) => request, parse = (body) => body, fetchImpl = fetch, injector = FailureInjector.fromEnv(), reliability = null, policy = {}, fallbacks = [] } = {}) {
    if (!name || !endpoint) throw new TypeError('name and endpoint are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError('maxAttempts must be 1..5');
    this.name = name; this.endpoint = endpoint; this.headers = { ...headers }; this.timeoutMs = timeoutMs; this.maxAttempts = maxAttempts; this.buildBody = buildBody; this.parse = parse; this.fetchImpl = fetchImpl; this.injector = injector; this.reliability = reliability || new ProviderReliability(); this.policy = { timeoutMs, maxAttempts, ...policy }; this.fallbacks = fallbacks;
  }

  async execute(request, context = {}) {
    if (context.__reliabilityManaged || context.attempt) return this.#executeOnce(request, context, context.attempt || 1);
    return (await this.reliability.execute({ provider: { name: this.name, execute: (req, ctx) => this.#executeOnce(req, ctx, ctx.attempt || 1) }, operation: context.operation || 'http', request, context, policy: this.policy, fallbacks: this.fallbacks, contract: { idempotent: this.idempotent !== false, allowFailover: this.allowFailover === true, contractCompatible: this.contractCompatible !== false } })).result;
  }

  async #executeOnce(request, context, attempt) {
    const obs = getActiveObservability(); const parent = getCurrentTraceContext(); const controller = new AbortController(); const externalSignal = context.signal; const onAbort = () => controller.abort(); externalSignal?.addEventListener('abort', onAbort, { once: true }); const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    try {
      await this.injector.trip('provider.before_call', { provider: this.name, attempt, retryable: true });
      const started = Date.now(); const invoke = async () => this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers, ...(parent ? { traceparent: traceparent(parent), 'x-correlation-id': parent.correlationId } : {}) }, body: JSON.stringify(this.buildBody(request)), signal: controller.signal });
      const response = obs ? await obs.withSpan(`provider:${this.name}`, { provider: this.name, attempt }, invoke) : await invoke();
      const text = await response.text(); let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error(`Provider ${this.name} returned invalid JSON`), { code: 'MALFORMED_PROVIDER_RESPONSE', status: response.status }); }
      if (!response.ok) { const error = new Error(`Provider ${this.name} returned HTTP ${response.status}`); error.status = response.status; error.retryAfter = response.headers?.get?.('retry-after'); error.providerBody = undefined; throw error; }
      if (obs) obs.metrics.inc('forge_provider_requests_total', { provider: this.name, outcome: 'success' });
      return this.parse(body, { latencyMs: Date.now() - started, attempt });
    } catch (error) {
      if (externalSignal?.aborted) throw Object.assign(new Error(`Provider ${this.name} request was cancelled`), { code: 'CANCELLED', retryable: false, cause: error });
      if (controller.signal.aborted) throw Object.assign(new Error(`Provider ${this.name} timed out after ${this.timeoutMs}ms`), { code: 'PROVIDER_TIMEOUT', retryable: true, cause: error });
      if (obs) obs.metrics.inc('forge_provider_requests_total', { provider: this.name, outcome: error.retryable ? 'retry' : 'failure' });
      throw error;
    } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', onAbort); }
  }
}

function openAiCompatibleChatProvider({ name = 'openai-compatible', endpoint, apiKey, model, timeoutMs = 120000, injector = FailureInjector.fromEnv(), reliability = null, fallbacks = [] } = {}) {
  if (!apiKey) throw new TypeError('apiKey is required'); if (!model) throw new TypeError('model is required');
  return new HttpJsonProvider({ name, endpoint, timeoutMs, injector, reliability, fallbacks, headers: { authorization: `Bearer ${apiKey}` }, buildBody: (request) => ({ model, messages: request.messages || [{ role: 'user', content: String(request.prompt || '') }], temperature: request.temperature ?? 0.2 }), parse: (body, meta) => ({ artifacts: [{ kind: 'text', content: body.choices?.[0]?.message?.content || '', mediaType: 'text/plain', metadata: { provider: name, model } }], usage: body.usage || {}, estimatedCost: null, actualCost: null, currency: 'USD', metadata: meta }) });
}
module.exports = { HttpJsonProvider, openAiCompatibleChatProvider };
