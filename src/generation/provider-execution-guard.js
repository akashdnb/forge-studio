const { setTimeout: delay } = require('node:timers/promises');

function timeoutError(timeoutMs) {
  return Object.assign(new Error(`Provider timed out after ${timeoutMs}ms`), {
    code: 'PROVIDER_TIMEOUT',
    retryable: false,
    details: { timeoutMs, ambiguous: true },
  });
}

async function executeProviderWithRetry(provider, request, context, { maxAttempts, timeoutMs, retryBaseMs, metrics } = {}) {
  let last;
  const attempts = Math.max(1, Number(maxAttempts || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const parentAbort = () => controller.abort();
    context.signal?.addEventListener('abort', parentAbort, { once: true });
    let timer;
    let timedOut = false;
    try {
      const execution = Promise.resolve(provider.execute(request, { ...context, attempt, signal: controller.signal }));
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      timer.unref?.();
      return await Promise.race([
        execution,
        delay(timeoutMs).then(() => { timedOut = true; controller.abort(); throw timeoutError(timeoutMs); }),
      ]);
    } catch (error) {
      if (timedOut || error?.code === 'PROVIDER_TIMEOUT') throw timeoutError(timeoutMs);
      last = error;
      const code = String(error?.code || '').toUpperCase();
      const status = Number(error?.status || error?.statusCode || 0);
      const retryable = status === 429 || status >= 500 || ['RATE_LIMITED', 'TOO_MANY_REQUESTS', 'PROVIDER_UNAVAILABLE', 'UPSTREAM_5XX', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code);
      if (!retryable || attempt >= attempts) break;
      const retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0));
      const waitMs = Math.min(retryAfterMs || Number(retryBaseMs || 1000) * (2 ** (attempt - 1)), 60000);
      metrics?.increment?.('forge_generation_retry', { capability: context.capability, reason: code || 'provider-retryable' });
      await delay(waitMs, undefined, { signal: context.signal });
    } finally {
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener('abort', parentAbort);
    }
  }
  throw last;
}

module.exports = { executeProviderWithRetry, timeoutError };
