const { TenantProjectLifecycle } = require('./tenant-project-lifecycle');

function createLifecycleHandlers({ pool, storage, logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const lifecycle = new TenantProjectLifecycle({ pool, storage });
  return {
    'lifecycle:plan-delete': async (payload = {}, job = {}) => {
      const result = await lifecycle.plan({ requestId: payload.requestId || job.payload?.requestId, tenantId: payload.tenantId, actor: payload.actor || job.created_by || 'system', dryRun: payload.dryRun !== false });
      logger.info?.({ event: 'lifecycle.deletion_plan', requestId: result.planId, status: result.status });
      return result;
    },
    'lifecycle:execute-delete': async (payload = {}, job = {}) => {
      const result = await lifecycle.execute({ requestId: payload.requestId || job.payload?.requestId, tenantId: payload.tenantId, actor: payload.actor || job.created_by || 'system', limit: payload.limit });
      logger.info?.({ event: 'lifecycle.deletion_execute', requestId: result.requestId, state: result.state, completed: result.completed, blocked: result.blocked });
      return result;
    },
    'lifecycle:reconcile': async (payload = {}) => lifecycle.reconcile({ tenantId: payload.tenantId, projectId: payload.projectId }),
  };
}

module.exports = { createLifecycleHandlers };
