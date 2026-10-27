const { Pool } = require('pg');
const { ProviderContractService } = require('../providers/provider-contract-service');
const { createStorageFromEnv } = require('../storage');
const { createGenerationJobHandler, createGenerationProviderRegistry } = require('./generation-worker');

let pool;
let handler;
function getHandler() {
  if (handler) return handler;
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is required for generation handlers'), { code: 'PROVIDER_NOT_CONFIGURED', retryable: false });
  if (!process.env.FORGE_PROVIDER_CONTRACT_SIGNING_SECRET) throw Object.assign(new Error('FORGE_PROVIDER_CONTRACT_SIGNING_SECRET is required for generation handlers'), { code: 'CONTRACT_UNAVAILABLE', retryable: false });
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  const providerRegistry = createGenerationProviderRegistry();
  providerRegistry.pool = pool;
  providerRegistry.contractService = new ProviderContractService({ pool });
  handler = createGenerationJobHandler({ pool, storage: createStorageFromEnv(), providerRegistry });
  return handler;
}
const lazy = async (payload, job) => getHandler()(payload, job);
module.exports = { handlers: { 'workflow:assets': lazy, 'generation:image': lazy, 'generation:video': lazy, 'generation:text': lazy } };
