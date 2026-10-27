const { randomUUID } = require('node:crypto');
const { FailureInjector } = require('../chaos/failure-injector');
const { createTraceContext } = require('../observability');

class JobQueue {
  constructor({ pool, leaseSeconds = 300, injector = FailureInjector.fromEnv(), observability = null, regionId = process.env.FORGE_REGION_ID || 'primary' }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new TypeError('leaseSeconds must be >= 10');
    if (!regionId || typeof regionId !== 'string') throw new TypeError('regionId is required');
    this.pool = pool; this.leaseSeconds = leaseSeconds; this.injector = injector; this.observability = observability; this.regionId = regionId;
  }
  async enqueue({ id = randomUUID(), projectId = null, episodeId = null, kind, payload = {}, priority = 100, maxAttempts = 3, idempotencyKey = id, createdBy = 'system', availableAt = null, dependsOnJobId = null, traceId = null, correlationId = null }) {
    if (!kind || typeof kind !== 'string') throw new TypeError('kind is required');
    if (!Number.isInteger(priority) || priority < 0) throw new TypeError('priority must be a non-negative integer');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError('maxAttempts must be 1..10');
    const context = this.observability?.context();
    const trace = createTraceContext({ traceId: traceId || context?.traceId, correlationId: correlationId || context?.correlationId });
    const result = await this.pool.query(`INSERT INTO forge_jobs (id,project_id,episode_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_by,depends_on_job_id,trace_id,correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,COALESCE($8,now()),$9,$10,$11,$12,$13) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=forge_jobs.updated_at RETURNING *`, [id, projectId, episodeId, kind, JSON.stringify(payload), priority, maxAttempts, availableAt, idempotencyKey, createdBy, dependsOnJobId, trace.traceId, trace.correlationId]);
    return result.rows[0];
  }
  async get(id) { const result = await this.pool.query('SELECT * FROM forge_jobs WHERE id=$1', [id]); return result.rows[0] || null; }
  async list({ projectId = null, episodeId = null, status = null, limit = 50, offset = 0 } = {}) {
    const values = [], where = [];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (episodeId) { values.push(episodeId); where.push(`episode_id=$${values.length}`); }
    if (status) { values.push(status); where.push(`status=$${values.length}`); }
    values.push(limit, offset);
    const result = await this.pool.query(`SELECT * FROM forge_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority ASC,created_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return result.rows;
  }
  async recoverBlockedDependencies() { const result = await this.pool.query(`UPDATE forge_jobs j SET status='CANCELLED',error=jsonb_build_object('message','Dependency failed or was cancelled'),finished_at=now(),updated_at=now() FROM forge_jobs d WHERE j.status='QUEUED' AND j.depends_on_job_id=d.id AND d.status IN('FAILED','CANCELLED') RETURNING j.id`); return result.rowCount; }
  async claim({ workerId, kinds = [], now = new Date() }) {
    await this.injector.trip('db.before_transaction', { workerId, retryable: true }); const client = await this.pool.connect();
    try { await client.query('BEGIN'); const params = [now, this.leaseSeconds, workerId, this.regionId]; let kind = '';
      if (kinds.length) { params.push(kinds); kind = `AND j.kind=ANY($${params.length}::text[])`; }
      const result = await client.query(`WITH candidate AS(SELECT j.id FROM forge_jobs j WHERE j.status='QUEUED' AND j.available_at<=$1 AND(j.leased_until IS NULL OR j.leased_until<$1) AND j.cancellation_requested_at IS NULL ${kind} AND(j.depends_on_job_id IS NULL OR EXISTS(SELECT 1 FROM forge_jobs d WHERE d.id=j.depends_on_job_id AND d.status='SUCCEEDED')) AND forge_job_fence_valid(j.tenant_id,j.execution_region,j.routing_epoch,j.fencing_token,$4) ORDER BY j.priority,j.created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE forge_jobs j SET status='RUNNING',attempts=j.attempts+1,worker_id=$3,leased_until=$1+($2::text||' seconds')::interval,started_at=COALESCE(j.started_at,now()),updated_at=now(),dispatch_generation=dispatch_generation+1,residency_block_reason=NULL FROM candidate x WHERE j.id=x.id RETURNING j.*`, params);
      const job = result.rows[0] || null; await this.injector.trip('worker.after_claim', { jobId: job?.id, workerId, retryable: true }); await client.query('COMMIT'); return job;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async claimSpecific(id, workerId, now = new Date()) {
    await this.injector.trip('db.before_transaction', { jobId: id, workerId, retryable: true }); const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await client.query(`UPDATE forge_jobs j SET status='RUNNING',attempts=j.attempts+1,worker_id=$2,leased_until=$3+($4::text||' seconds')::interval,started_at=COALESCE(j.started_at,now()),updated_at=now(),dispatch_generation=dispatch_generation+1 WHERE j.id=$1 AND j.status='QUEUED' AND j.available_at<=$3 AND(j.leased_until IS NULL OR j.leased_until<$3) AND j.cancellation_requested_at IS NULL AND(j.depends_on_job_id IS NULL OR EXISTS(SELECT 1 FROM forge_jobs d WHERE d.id=j.depends_on_job_id AND d.status='SUCCEEDED')) AND forge_job_fence_valid(j.tenant_id,j.execution_region,j.routing_epoch,j.fencing_token,$5) RETURNING j.*`, [id, workerId, now, this.leaseSeconds, this.regionId]); const job = result.rows[0] || null; await this.injector.trip('worker.after_claim', { jobId: id, workerId, retryable: true }); await client.query('COMMIT'); return job;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async heartbeat(id, workerId, dispatchToken = null) { await this.injector.trip('worker.before_heartbeat', { jobId: id, workerId, retryable: true }); const result = await this.pool.query(`UPDATE forge_jobs SET leased_until=now()+($1::text||' seconds')::interval,updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 AND($4::text IS NULL OR dispatch_token=$4) AND cancellation_requested_at IS NULL AND forge_job_fence_valid(tenant_id,execution_region,routing_epoch,fencing_token,$5) RETURNING *`, [this.leaseSeconds, id, workerId, dispatchToken, this.regionId]); return result.rows[0] || null; }
  async succeed(id, workerId, result = {}, dispatchToken = null) { await this.injector.trip('worker.before_succeed', { jobId: id, workerId, retryable: false }); const updated = await this.pool.query(`UPDATE forge_jobs SET status='SUCCEEDED',result=$1::jsonb,leased_until=NULL,dispatch_token=NULL,timeout_at=NULL,finished_at=now(),updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 AND($4::text IS NULL OR dispatch_token=$4) AND forge_job_fence_valid(tenant_id,execution_region,routing_epoch,fencing_token,$5) RETURNING *`, [JSON.stringify(result), id, workerId, dispatchToken, this.regionId]); if (!updated.rows[0]) throw Object.assign(new Error(`Job ${id} is not owned by worker ${workerId}, has been fenced, or has been superseded`), { code: 'STALE_WORKER' }); return updated.rows[0]; }
  async cancel(id, workerId, reason = 'Cancelled by admission control') { const updated = await this.pool.query(`UPDATE forge_jobs SET status='CANCELLED',leased_until=NULL,dispatch_token=NULL,timeout_at=NULL,error=$1::jsonb,finished_at=now(),updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 AND forge_job_fence_valid(tenant_id,execution_region,routing_epoch,fencing_token,$4) RETURNING *`, [JSON.stringify({ message: reason }), id, workerId, this.regionId]); if (!updated.rows[0]) throw Object.assign(new Error(`Job ${id} is not owned by worker ${workerId} or has been fenced`), { code: 'STALE_WORKER' }); return updated.rows[0]; }
  async fail(id, workerId, error, { retry = true, delaySeconds = 30, dispatchToken = null } = {}) {
    await this.injector.trip('worker.before_fail', { jobId: id, workerId, retryable: true }); const client = await this.pool.connect();
    try { await client.query('BEGIN'); const current = await client.query('SELECT * FROM forge_jobs WHERE id=$1 FOR UPDATE'); const job = current.rows[0]; const valid = job ? (await client.query('SELECT forge_job_fence_valid($1,$2,$3,$4,$5) AS valid', [job.tenant_id, job.execution_region, job.routing_epoch, job.fencing_token, this.regionId])).rows[0].valid : false;
      if (!job || job.status !== 'RUNNING' || job.worker_id !== workerId || (dispatchToken && job.dispatch_token !== dispatchToken) || !valid) throw Object.assign(new Error(`Job ${id} is not owned by worker ${workerId}, has been fenced, or has been superseded`), { code: 'STALE_WORKER' });
      const retryable = retry && job.attempts < job.max_attempts; const updated = await client.query(retryable ? `UPDATE forge_jobs SET status='QUEUED',available_at=now()+($1::text||' seconds')::interval,leased_until=NULL,worker_id=NULL,dispatch_token=NULL,timeout_at=NULL,error=$2::jsonb,updated_at=now() WHERE id=$3 AND cancellation_requested_at IS NULL RETURNING *` : `UPDATE forge_jobs SET status='FAILED',leased_until=NULL,worker_id=NULL,dispatch_token=NULL,timeout_at=NULL,error=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$3 RETURNING *`, retryable ? [Math.max(1, delaySeconds), JSON.stringify({ message: error?.message || String(error) }), id] : [null, JSON.stringify({ message: error?.message || String(error) }), id]); await this.injector.trip('db.after_mutation', { jobId: id, workerId, retryable: true }); await client.query('COMMIT'); return updated.rows[0];
    } catch (err) { try { await client.query('ROLLBACK'); } catch {} throw err; } finally { client.release(); }
  }
  async recoverExpiredLeases() { const result = await this.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,dispatch_token=NULL,timeout_at=NULL,available_at=now(),updated_at=now() WHERE status='RUNNING' AND leased_until<now() AND timeout_at IS NULL AND cancellation_requested_at IS NULL AND forge_job_fence_valid(tenant_id,execution_region,routing_epoch,fencing_token,$1) RETURNING id`, [this.regionId]); return result.rowCount; }
}
module.exports = { JobQueue };
