'use strict';

const { DurablePrivacyRetentionWorker } = require('./retention-worker');
const { PrivacyGovernance } = require('./privacy-governance');

function createPrivacyHandlers({ pool, storage = null, logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const worker = new DurablePrivacyRetentionWorker({ pool, storage, batchSize: Number.parseInt(process.env.FORGE_PRIVACY_RETENTION_BATCH_SIZE || '100', 10) });
  const governance = worker.governance;
  return {
    'privacy:retention-scan': async (payload = {}, job = {}) => {
      const tenantId = payload.tenantId || job.tenant_id || job.payload?.tenantId;
      if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'INVALID_SCOPE', retryable: false });
      const result = await worker.run({ tenantId, runId: payload.runId || job.payload?.runId, limit: payload.limit });
      logger.info?.({ event: 'privacy.retention.scan', tenantId, runId: result.runId, status: result.status, scanned: result.scanned, eligible: result.eligible, blocked: result.blocked });
      return result;
    },
    'privacy:retention-execute': async (payload = {}, job = {}) => {
      const tenantId = payload.tenantId || job.tenant_id || job.payload?.tenantId;
      if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'INVALID_SCOPE', retryable: false });
      const result = await governance.execute({ tenantId, limit: payload.limit });
      logger.info?.({ event: 'privacy.retention.execute', tenantId, destroyed: result.destroyed.length, blocked: result.blocked.length });
      return result;
    },
  };
}

module.exports = { createPrivacyHandlers };
