const { TenantProjectLifecycle } = require('./tenant-project-lifecycle');
const { PrivacyGovernance } = require('../privacy/privacy-governance');
const { ProductionArtifactLifecycleControlPlane } = require('../storage/artifact-lifecycle-production');

function createLifecycleHandlers({ pool, storage, logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const lifecycle = new TenantProjectLifecycle({ pool, storage });
  const privacy = new PrivacyGovernance({ pool, storage });
  const artifactGc = new ProductionArtifactLifecycleControlPlane({ pool, storage });
  return {
    'lifecycle:plan-delete': async (payload = {}, job = {}) => {
      const tenantId = payload.tenantId || job.payload?.tenantId;
      await privacy.guardDestructiveAction({ tenantId, projectId: payload.projectId || job.payload?.projectId || null, action: 'lifecycle:plan-delete', actor: payload.actor || job.created_by || 'system' });
      const result = await lifecycle.plan({ requestId: payload.requestId || job.payload?.requestId, tenantId, actor: payload.actor || job.created_by || 'system', dryRun: payload.dryRun !== false });
      logger.info?.({ event: 'lifecycle.deletion_plan', requestId: result.planId, status: result.status });
      return result;
    },
    'lifecycle:execute-delete': async (payload = {}, job = {}) => {
      const tenantId = payload.tenantId || job.payload?.tenantId;
      await privacy.guardDestructiveAction({ tenantId, projectId: payload.projectId || job.payload?.projectId || null, action: 'lifecycle:execute-delete', actor: payload.actor || job.created_by || 'system' });
      const result = await lifecycle.execute({ requestId: payload.requestId || job.payload?.requestId, tenantId, actor: payload.actor || job.created_by || 'system', limit: payload.limit });
      logger.info?.({ event: 'lifecycle.deletion_execute', requestId: result.requestId, state: result.state, completed: result.completed, blocked: result.blocked });
      return result;
    },
    'lifecycle:reconcile': async (payload = {}) => lifecycle.reconcile({ tenantId: payload.tenantId, projectId: payload.projectId }),
    'workflow:artifact-gc-preview': async (payload = {}, job = {}) => artifactGc.preview({ tenantId: payload.tenantId || job.payload?.tenantId, actor: payload.actor || job.created_by || 'system', policy: payload.policy || {} }),
    'workflow:artifact-gc-mark': async (payload = {}, job = {}) => artifactGc.markGeneration({ tenantId: payload.tenantId || job.payload?.tenantId, generationId: payload.generationId || job.payload?.generationId, actor: payload.actor || job.created_by || 'system', scanLimit: payload.scanLimit }),
    'workflow:artifact-gc-sweep': async (payload = {}, job = {}) => artifactGc.sweepGeneration({ tenantId: payload.tenantId || job.payload?.tenantId, generationId: payload.generationId || job.payload?.generationId, actor: payload.actor || job.created_by || 'system', dryRun: payload.dryRun === true }),
    'workflow:artifact-gc-approve': async (payload = {}, job = {}) => artifactGc.approveGeneration({ tenantId: payload.tenantId || job.payload?.tenantId, generationId: payload.generationId || job.payload?.generationId, actor: payload.actor || job.created_by || 'system' }),
    'workflow:artifact-gc-delete': async (payload = {}, job = {}) => artifactGc.executeApprovedDeletes({ tenantId: payload.tenantId || job.payload?.tenantId, generationId: payload.generationId || job.payload?.generationId, actor: payload.actor || job.created_by || 'system', maxDeletes: payload.maxDeletes, maxDeleteBytes: payload.maxDeleteBytes }),
    'workflow:artifact-gc-reconcile': async (payload = {}, job = {}) => artifactGc.reconcileProvider({ tenantId: payload.tenantId || job.payload?.tenantId, limit: payload.limit }),
    'workflow:artifact-gc-recover-leases': async (payload = {}, job = {}) => artifactGc.recoverStaleLeases({ tenantId: payload.tenantId || job.payload?.tenantId, limit: payload.limit }),
  };
}

module.exports = { createLifecycleHandlers };
