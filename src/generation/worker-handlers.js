const { PersistentProductionRepository } = require('../persistence/production-repository');
const { createStorageFromEnv } = require('../storage');
const { createProviderRegistry } = require('./provider-registry');
const { createGenerationWorker } = require('./generation-worker');

function createGenerationHandlers({ pool, logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const repository = new PersistentProductionRepository({ pool });
  const storage = createStorageFromEnv();
  const providerRegistry = createProviderRegistry();
  const handler = createGenerationWorker({ pool, repository, storage, providerRegistry, logger });
  return { 'workflow:assets': handler, 'workflow:generation': handler };
}

module.exports = { createGenerationHandlers };