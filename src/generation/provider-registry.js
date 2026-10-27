const crypto = require('node:crypto');

const CAPABILITIES = Object.freeze(['image', 'video', 'text']);
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024;

function fail(message, code, retryable = false, details = {}) {
  return Object.assign(new Error(message), { code, retryable, details });
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  return null;
}

function classifyHttpFailure(status) {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return false;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

class GenerationProviderRegistry {
  #providers = new Map();

  register(capability, provider) {
    if (!CAPABILITIES.includes(capability)) throw new TypeError(`Unsupported generation capability: ${capability}`);
    if (!provider || typeof provider.execute !== 'function') throw new TypeError('provider.execute(request, context) is required');
    const key = `${capability}:${provider.name || 'unnamed'}`;
    if (this.#providers.has(key)) throw new Error(`Generation provider already registered: ${key}`);
    this.#providers.set(key, Object.freeze({ ...provider, capability }));
    return { capability, name: provider.name || 'unnamed', model: provider.model || null };
  }

  get(capability, name = null) {
    const matches = [...this.#providers.values()].filter((provider) => provider.capability === capability);
    if (name) return matches.find((provider) => provider.name === name) || null;
    return matches[0] || null;
  }

  list() {
    return [...this.#providers.values()].map((provider) => ({ capability: provider.capability, name: provider.name || 'unnamed', model: provider.model || null }));
  }
}

class HttpGenerationProvider {
  constructor({ capability, name, endpoint, token = null, model = null, timeoutMs = 120_000, fetchImpl = fetch, maxResponseBytes = MAX_PROVIDER_RESPONSE_BYTES } = {}) {
    if (!CAPABILITIES.includes(capability)) throw new TypeError('capability is invalid');
    if (!name || !endpoint) throw new TypeError('name and endpoint are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError('maxResponseBytes must be >= 1024');
    this.capability = capability;
    this.name = name;
    this.endpoint = endpoint;
    this.token = token;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.maxResponseBytes = maxResponseBytes;
  }

  async execute(request, context = {}) {
    if (context.signal?.aborted) throw fail('Generation provider was cancelled', 'CANCELLED');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    context.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, context.timeoutMs || this.timeoutMs));
    timeout.unref?.();
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const startedAt = Date.now();
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contractVersion: 'forge-generation-v1',
            capability: this.capability,
            model: this.model,
            request,
            inputVersionIds: context.inputVersionIds || [],
            idempotencyKey: context.idempotencyKey,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (context.signal?.aborted) throw fail('Generation provider was cancelled', 'CANCELLED');
        if (error?.name === 'AbortError') throw fail(`Generation provider timed out after ${context.timeoutMs || this.timeoutMs}ms`, 'PROVIDER_TIMEOUT', true);
        throw fail(`Generation provider network failure: ${error.message}`, 'PROVIDER_UNAVAILABLE', true);
      }
      const reader = response.body?.getReader?.();
      let bytes = 0;
      const chunks = [];
      if (reader) {
        while (true) {
          if (context.signal?.aborted) throw fail('Generation provider was cancelled', 'CANCELLED');
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > this.maxResponseBytes) throw fail('Generation provider response exceeded the configured limit', 'PROVIDER_RESPONSE_TOO_LARGE');
          chunks.push(Buffer.from(next.value));
        }
      } else {
        const text = await response.text();
        bytes = Buffer.byteLength(text);
        if (bytes > this.maxResponseBytes) throw fail('Generation provider response exceeded the configured limit', 'PROVIDER_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(text));
      }
      const raw = Buffer.concat(chunks, bytes);
      let body;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { throw fail(`Generation provider ${this.name} returned malformed JSON`, 'MALFORMED_PROVIDER_RESPONSE', response.status >= 500); }
      if (!response.ok) {
        const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
        throw fail(`Generation provider ${this.name} returned HTTP ${response.status}`, response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_HTTP_ERROR', classifyHttpFailure(response.status), { status: response.status, retryAfterMs });
      }
      return { ...body, metadata: { ...(body?.metadata || {}), provider: this.name, model: this.model, latencyMs: Date.now() - startedAt } };
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

class OpenAICompatibleTextProvider extends HttpGenerationProvider {
  constructor(options = {}) { super({ ...options, capability: 'text' }); }

  async execute(request, context = {}) {
    const response = await super.execute({
      ...request,
      messages: request.messages || [{ role: 'user', content: String(request.prompt || '') }],
      temperature: request.temperature ?? 0.2,
    }, context);
    if (response?.artifact) return response;
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw fail('OpenAI-compatible text provider returned empty content', 'MALFORMED_PROVIDER_RESPONSE');
    return { ...response, artifact: { content, mediaType: 'text/plain' } };
  }
}

function createGenerationProviderRegistry({ config = {}, fetchImpl = fetch } = {}) {
  const registry = new GenerationProviderRegistry();
  const mode = String(config.mode || process.env.FORGE_GENERATION_MODE || '').toLowerCase();
  const timeoutMs = Number(config.timeoutMs || process.env.FORGE_GENERATION_TIMEOUT_MS || 120_000);
  const maxResponseBytes = Number(config.maxProviderResponseBytes || process.env.FORGE_GENERATION_MAX_PROVIDER_RESPONSE_BYTES || MAX_PROVIDER_RESPONSE_BYTES);
  const deterministic = createDeterministicProviders();
  if (mode === 'deterministic' || mode === 'test' || process.env.NODE_ENV === 'test') {
    for (const capability of CAPABILITIES) registry.register(capability, deterministic[capability]);
    return registry;
  }
  for (const capability of CAPABILITIES) {
    const prefix = `FORGE_GENERATION_${capability.toUpperCase()}`;
    const endpoint = config[`${capability}Endpoint`] || process.env[`${prefix}_ENDPOINT`];
    const token = config[`${capability}Token`] || process.env[`${prefix}_TOKEN`] || process.env.FORGE_GENERATION_PROVIDER_TOKEN || null;
    const model = config[`${capability}Model`] || process.env[`${prefix}_MODEL`] || null;
    const providerName = config[`${capability}Provider`] || process.env[`${prefix}_PROVIDER`] || (capability === 'text' ? 'openai-compatible' : 'http-json');
    if (!endpoint) continue;
    const provider = capability === 'text' && providerName === 'openai-compatible'
      ? new OpenAICompatibleTextProvider({ name: providerName, endpoint, token, model, timeoutMs, fetchImpl, maxResponseBytes })
      : new HttpGenerationProvider({ capability, name: providerName, endpoint, token, model, timeoutMs, fetchImpl, maxResponseBytes });
    registry.register(capability, provider);
  }
  return registry;
}

function deterministicText(request) {
  const prompt = String(request.prompt || request.text || '').trim();
  if (!prompt) throw fail('Deterministic text generation requires a prompt', 'INVALID_INPUT');
  return `Generated educational copy for: ${prompt}`;
}

function deterministicPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAEElEQVR42mNgGAWjYBTAAAADEAAB1y2EYwAAAABJRU5ErkJggg==', 'base64');
}

function deterministicMp4() {
  return Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZlZHQAAAAAAAAAAQAAAK5lbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANEAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaXN0AAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMwAAAAhmcmVlAAACzW1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgYl9wcmF5cm9pZD0yIGJfYWRhcHQ9MSBiX2JpYXg9MCBkaXJlY3Q9MSB3ZWlnaHQ9MSBvcGVuX2dvcD0wIG9wZW5fc3JsaT0wIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYWw9MSBpbnRlcmxhY2VkPTAgbWl4ZWRfbmV0X3Jlc29sdXRpb249MTYgeDE2IGNicT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdD0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWludGVkX2ludHJhPTAgbF9jb21wPTAuNjAgcXBtaW49MSBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMCAAAAAAABBliIQAFf/+98nvwKbr29+B', 'base64');
}

function createDeterministicProviders() {
  return {
    text: { name: 'deterministic-local', model: 'forge-text-v1', execute: async (request) => ({ artifact: { content: deterministicText(request), mediaType: 'text/plain' }, metadata: { deterministic: true } }) },
    image: { name: 'deterministic-local', model: 'forge-image-v1', execute: async () => ({ artifact: { contentBase64: deterministicPng().toString('base64'), mediaType: 'image/png' }, metadata: { deterministic: true } }) },
    video: { name: 'deterministic-local', model: 'forge-video-v1', execute: async () => ({ artifact: { contentBase64: deterministicMp4().toString('base64'), mediaType: 'video/mp4' }, metadata: { deterministic: true } }) },
  };
}

module.exports = {
  CAPABILITIES,
  GenerationProviderRegistry,
  HttpGenerationProvider,
  OpenAICompatibleTextProvider,
  createGenerationProviderRegistry,
  createDeterministicProviders,
  classifyHttpFailure,
  parseRetryAfter,
  sha256,
};