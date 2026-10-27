const { createCrossSystemIntegrityHandler, CrossSystemIntegrityReconciler } = require('./cross-system-integrity');

function createIntegrityHandlers({ pool, storage, observability, workerId, config = {} } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const options = { pool, storage, observability, workerId, pageSize: config.pageSize, concurrency: config.concurrency, staleLeaseMinutes: config.staleLeaseMinutes };
  return {
    'system:integrity-reconcile': createCrossSystemIntegrityHandler(options),
    'workflow:integrity-reconcile': createCrossSystemIntegrityHandler(options),
  };
}

module.exports = { createIntegrityHandlers, CrossSystemIntegrityReconciler };
