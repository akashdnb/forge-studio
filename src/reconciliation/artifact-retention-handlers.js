const { ArtifactRetentionOptimizer } = require('../storage/artifact-retention-optimizer');
const { ArtifactDuplicateCompactor } = require('../storage/artifact-duplicate-compactor');

function parsePolicy() {
  let parsed = {};
  if (process.env.FORGE_ARTIFACT_GC_POLICY_JSON) {
    try { parsed = JSON.parse(process.env.FORGE_ARTIFACT_GC_POLICY_JSON); }
    catch (error) { throw Object.assign(new Error(`Invalid FORGE_ARTIFACT_GC_POLICY_JSON: ${error.message}`), { code: 'INVALID_CONFIGURATION', retryable: false }); }
  }
  return parsed;
}

function createArtifactRetentionHandlers({ pool, storage, observability = null, workerId } = {}) {
  if (!pool || !storage) throw new TypeError('pool and storage are required');
  const policy = parsePolicy();
  const optimizer = new ArtifactRetentionOptimizer({ pool, storage, workerId, policy, metrics: observability?.metrics });
  const duplicateCompactor = new ArtifactDuplicateCompactor({ pool, storage, signal: null });

  async function run(payload = {}) {
    const action = payload.action || 'plan';
    const tenantId = payload.tenantId;
    if (!tenantId) throw Object.assign(new Error('tenantId is required for artifact retention jobs'), { code: 'INVALID_SCOPE', retryable: false });
    if (action === 'plan') {
      const plan = await optimizer.createPlan({ tenantId, createdBy: payload.actor || workerId, mode: payload.mode || 'DRY_RUN', policy: payload.policy || {}, reason: payload.reason || 'durable-job', scanLimit: payload.scanLimit, maxDeleteBytes: payload.maxDeleteBytes });
      const scanned = await optimizer.executePlan({ tenantId, planId: plan.id });
      return { planId: scanned.id, status: scanned.status, report: scanned.report, usageAccounting: { storageBytesScanned: Number(scanned.bytes_reclaimable || 0) } };
    }
    if (action === 'approve') return { plan: await optimizer.approvePlan({ tenantId, planId: payload.planId, actor: payload.actor }) };
    if (action === 'cancel') return { plan: await optimizer.cancelPlan({ tenantId, planId: payload.planId }) };
    if (action === 'compact') {
      const duplicates = await duplicateCompactor.compact({ tenantId, maxObjects: payload.maxDuplicates || 25 });
      const result = await optimizer.compactApprovedPlan({ tenantId, planId: payload.planId, maxDeletes: payload.maxDeletes });
      return { result, duplicates, usageAccounting: { storageBytesReclaimed: Number(duplicates.bytesReclaimed || 0) + Number(result.deletedBytes || 0) } };
    }
    if (action === 'report') return optimizer.report({ tenantId, planId: payload.planId });
    throw Object.assign(new Error(`Unsupported artifact retention action: ${action}`), { code: 'INVALID_ACTION', retryable: false });
  }

  return {
    'workflow:artifact-retention': run,
    'workflow:artifact-compaction': async (payload = {}) => run({ ...payload, action: 'compact' }),
  };
}

module.exports = { createArtifactRetentionHandlers };
