const { createStorageFromEnv } = require('../storage');
const { createGenerationJobHandler, createGenerationProviderRegistry } = require('./generation-worker');

function createGenerationHandlers({ pool, storage = null, providerRegistry = null, config = {}, metrics = null, logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const effectiveStorage = storage || createStorageFromEnv();
  const registry = providerRegistry || createGenerationProviderRegistry();
  const handler = createGenerationJobHandler({ pool, storage: effectiveStorage, providerRegistry: registry, config, metrics, logger });
  return {
    'workflow:assets': handler,
    'generation:image': handler,
    'generation:video': handler,
    'generation:text': handler,
  };
}

module.exports = { createGenerationHandlers };
