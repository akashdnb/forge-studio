'use strict';
const { JobQueue } = require('../persistence/job-queue');
const { TenantResourceFairness, ResourceAdmissionError } = require('./tenant-resource-fairness');

const marker = Symbol.for('forge.tenant.resource.fairness');
if (!JobQueue.prototype[marker]) {
  const originalClaim = JobQueue.prototype.claim;
  const originalClaimSpecific = JobQueue.prototype.claimSpecific;
  const originalSucceed = JobQueue.prototype.succeed;
  const originalFail = JobQueue.prototype.fail;
  const originalCancel = JobQueue.prototype.cancel;
  const originalRecover = JobQueue.prototype.recoverExpiredLeases;

  JobQueue.prototype.claim = async function fairClaim(options = {}) {
    if (!this.pool) return originalClaim.call(this, options);
    if (!this._tenantFairness) this._tenantFairness = new TenantResourceFairness({ pool: this.pool });
    const maxRounds = Math.max(2, Math.min(32, Number(process.env.FORGE_FAIRNESS_CLAIM_ROUNDS || 16)));
    for (let round = 0; round < maxRounds; round += 1) {
      const candidate = await selectFairCandidate(this.pool, options);
      if (!candidate) return null;
      const claimed = await originalClaimSpecific.call(this, candidate.id, options.workerId, options.now || new Date());
      if (!claimed) continue;
      try {
        const reservation = await this._tenantFairness.claim({ job: claimed, workerId: options.workerId, now: options.now || new Date() });
        if (!reservation) throw new ResourceAdmissionError('resource reservation unavailable', { code: 'RESOURCE_RESERVATION_UNAVAILABLE' });
        return claimed;
      } catch (error) {
        await this.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=GREATEST(available_at,now()+interval '250 milliseconds'),updated_at=now(),error=$1::jsonb WHERE id=$2 AND status='RUNNING'`, [JSON.stringify({ code: error.code || 'RESOURCE_QUOTA_EXCEEDED', message: error.message }), claimed.id]);
        if (error.code !== 'RESOURCE_CONCURRENCY_EXCEEDED' && error.code !== 'RESOURCE_JOB_COUNT_EXCEEDED' && error.code !== 'RESOURCE_CPU_EXCEEDED' && error.code !== 'RESOURCE_EMERGENCY_THROTTLE') throw error;
      }
    }
    return null;
  };

  JobQueue.prototype.succeed = async function fairSucceed(id, workerId, result = {}, dispatchToken = null) {
    const job = await this.get(id);
    const updated = await originalSucceed.call(this, id, workerId, result, dispatchToken);
    try { await this._tenantFairness?.release(id, job?.attempts, { outcome: 'COMMITTED', actualCpuMs: result?.usage?.cpuMs ?? result?.cpuMs ?? null, reason: 'job_succeeded' }); } catch (error) { this.observability?.metrics?.inc?.('forge_resource_release_failures_total'); }
    return updated;
  };

  JobQueue.prototype.fail = async function fairFail(id, workerId, error, options = {}) {
    const job = await this.get(id);
    const updated = await originalFail.call(this, id, workerId, error, options);
    try { await this._tenantFairness?.release(id, job?.attempts, { outcome: 'RELEASED', reason: updated?.status === 'QUEUED' ? 'retry' : 'job_failed' }); } catch (releaseError) { this.observability?.metrics?.inc?.('forge_resource_release_failures_total'); }
    return updated;
  };

  JobQueue.prototype.cancel = async function fairCancel(id, workerId, reason) {
    const job = await this.get(id);
    const updated = await originalCancel.call(this, id, workerId, reason);
    try { await this._tenantFairness?.release(id, job?.attempts, { outcome: 'RELEASED', reason: reason || 'job_cancelled' }); } catch (error) { this.observability?.metrics?.inc?.('forge_resource_release_failures_total'); }
    return updated;
  };

  JobQueue.prototype.recoverExpiredLeases = async function fairRecover() {
    const count = await originalRecover.call(this);
    try { await this._tenantFairness?.recoverStale(); } catch (error) { this.observability?.metrics?.inc?.('forge_resource_stale_recovery_failures_total'); }
    return count;
  };

  JobQueue.prototype[marker] = true;
}

async function selectFairCandidate(pool, options = {}) {
  const kinds = Array.isArray(options.kinds) ? options.kinds : [];
  const values = [options.now || new Date(), kinds];
  const kindClause = kinds.length ? 'AND j.kind=ANY($2::text[])' : '';
  const query = `WITH candidates AS (
    SELECT j.id,j.tenant_id,j.project_id,j.priority,j.created_at,
      COALESCE(pp.priority_class,tp.priority_class,j.priority,100) priority_class,
      COALESCE(pp.queue_weight,tp.queue_weight,1) queue_weight,
      COALESCE(f.virtual_finish,0) virtual_finish,
      COALESCE(pp.aging_seconds,tp.aging_seconds,60) aging_seconds,
      EXTRACT(EPOCH FROM ($1-j.created_at)) age_seconds
    FROM forge_jobs j
    JOIN forge_resource_policies tp ON tp.scope_type='TENANT' AND tp.tenant_id=j.tenant_id AND tp.active
    LEFT JOIN forge_resource_policies pp ON pp.scope_type='PROJECT' AND pp.project_id=j.project_id AND pp.tenant_id=j.tenant_id AND pp.active
    LEFT JOIN forge_resource_fairness f ON f.tenant_id=j.tenant_id AND f.project_id=COALESCE(j.project_id,'')
    WHERE j.status='QUEUED' AND j.available_at<=$1 AND (j.leased_until IS NULL OR j.leased_until<$1)
      AND j.cancellation_requested_at IS NULL ${kindClause}
      AND (j.depends_on_job_id IS NULL OR EXISTS(SELECT 1 FROM forge_jobs d WHERE d.id=j.depends_on_job_id AND d.status='SUCCEEDED'))
      AND forge_job_fence_valid(j.tenant_id,j.execution_region,j.routing_epoch,j.fencing_token,$3)
  )
  SELECT id FROM candidates ORDER BY priority_class - FLOOR(age_seconds/GREATEST(aging_seconds,1)), virtual_finish/GREATEST(queue_weight,1), priority, created_at, id LIMIT 1`;
  values.push(options.regionId || process.env.FORGE_REGION_ID || 'primary');
  const result = await pool.query(query, values);
  return result.rows[0] || null;
}

module.exports = { selectFairCandidate };
