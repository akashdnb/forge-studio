const { randomUUID } = require('node:crypto');
const { requiredString } = require('../domain/records');

const JOB_STATES = Object.freeze(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

class DurableJobQueue {
  constructor({ pool, workerId = `worker-${randomUUID()}`, leaseSeconds = 90 }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new TypeError('leaseSeconds must be 5..3600');
    this.pool = pool;
    this.workerId = requiredString(workerId, 'workerId');
    this.leaseSeconds = leaseSeconds;
  }

  async enqueue({ id = randomUUID(), episodeId, stage, capability, idempotencyKey, request = {}, inputVersionIds = [], maxAttempts = 3, priority = 0, createdBy = 'system' }) {
    episodeId = requiredString(episodeId, 'episodeId');
    idempotencyKey = requiredString(idempotencyKey, 'idempotencyKey');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError('maxAttempts must be 1..10');
    if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
    if (!['RESEARCH','SCRIPT','SCENE_PLAN','NARRATION','ASSETS','TIMELINE','RENDER','QA','PUBLISH'].includes(stage)) throw new TypeError('Unknown workflow stage');
    const result = await this.pool.query(
      `INSERT INTO workflow_jobs (id,episode_id,stage,capability,idempotency_key,request,input_version_ids,max_attempts,priority,created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING *`,
      [id, episodeId, stage, requiredString(capability, 'capability'), idempotencyKey, JSON.stringify(request), JSON.stringify(inputVersionIds), maxAttempts, priority, createdBy],
    );
    const job = result.rows[0];
    if (job.episode_id !== episodeId) throw Object.assign(new Error('Job idempotency key belongs to a different episode'), { code: 'IDEMPOTENCY_CONFLICT' });
    return job;
  }

  async claim() {
    return this.withTransaction(async (client) => {
      // If a worker disappeared after its final allowed attempt, terminate the
      // job instead of perpetually reclaiming an expired lease.
      const exhausted = await client.query(
        `UPDATE workflow_jobs SET status='FAILED',locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,
         lease_expires_at=NULL,finished_at=now(),updated_at=now(),
         error=jsonb_build_object('message','Worker lease expired after max attempts','retryable',false)
         WHERE status='RUNNING' AND lease_expires_at < now() AND attempts >= max_attempts
         RETURNING id`,
      );
      for (const row of exhausted.rows) {
        await client.query("INSERT INTO workflow_job_events (job_id,event_type,details) VALUES ($1,'JOB_FAILED_LEASE_EXHAUSTED','{}'::jsonb)", [row.id]);
      }
      const result = await client.query(
        `WITH candidate AS (
           SELECT id FROM workflow_jobs
           WHERE ((status='QUEUED' AND available_at <= now()) OR (status='RUNNING' AND lease_expires_at < now()))
             AND attempts < max_attempts
           ORDER BY priority DESC, available_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE workflow_jobs job SET status='RUNNING', attempts=job.attempts+1,
           locked_by=$1, locked_at=now(), heartbeat_at=now(),
           lease_expires_at=now() + ($2::text || ' seconds')::interval, updated_at=now()
         FROM candidate WHERE job.id=candidate.id RETURNING job.*`,
        [this.workerId, this.leaseSeconds],
      );
      const job = result.rows[0];
      if (job) await client.query(
        "INSERT INTO workflow_job_events (job_id,event_type,details) VALUES ($1,'JOB_CLAIMED',$2::jsonb)",
        [job.id, JSON.stringify({ workerId: this.workerId, attempt: job.attempts })],
      );
      return job || null;
    });
  }

  async heartbeat(jobId) {
    const result = await this.pool.query(
      `UPDATE workflow_jobs SET heartbeat_at=now(),lease_expires_at=now()+($1::text || ' seconds')::interval,updated_at=now()
       WHERE id=$2 AND status='RUNNING' AND locked_by=$3 AND lease_expires_at > now() RETURNING *`,
      [this.leaseSeconds, jobId, this.workerId],
    );
    if (!result.rows[0]) throw Object.assign(new Error('Job lease is no longer owned by this worker'), { code: 'LEASE_LOST' });
    return result.rows[0];
  }

  async complete(jobId, resultPayload = {}) { return this.#finish(jobId, 'SUCCEEDED', { result: resultPayload }); }

  async fail(jobId, error, { retryable = false, retryDelaySeconds = 10 } = {}) {
    if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 0 || retryDelaySeconds > 86400) throw new TypeError('retryDelaySeconds must be 0..86400');
    return this.withTransaction(async (client) => {
      const selected = await client.query("SELECT * FROM workflow_jobs WHERE id=$1 AND status='RUNNING' AND locked_by=$2 AND lease_expires_at > now() FOR UPDATE", [jobId, this.workerId]);
      const job = selected.rows[0];
      if (!job) throw Object.assign(new Error('Job lease is no longer owned by this worker'), { code: 'LEASE_LOST' });
      const retry = retryable && job.attempts < job.max_attempts;
      const status = retry ? 'QUEUED' : 'FAILED';
      const next = await client.query(
        `UPDATE workflow_jobs SET status=$1,available_at=CASE WHEN $1='QUEUED' THEN now()+($2::text || ' seconds')::interval ELSE available_at END,
         locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,error=$3::jsonb,
         finished_at=CASE WHEN $1='FAILED' THEN now() ELSE NULL END,updated_at=now()
         WHERE id=$4 RETURNING *`,
        [status,retryDelaySeconds,JSON.stringify({ message: String(error?.message || error || 'Unknown error'), retryable }),jobId],
      );
      await client.query('INSERT INTO workflow_job_events (job_id,event_type,details) VALUES ($1,$2,$3::jsonb)', [
        jobId, retry ? 'JOB_RETRY_SCHEDULED' : 'JOB_FAILED', JSON.stringify({ attempts: job.attempts, retryable }),
      ]);
      return next.rows[0];
    });
  }

  async cancel(jobId) {
    return this.withTransaction(async (client) => {
      const row = await client.query(
        `UPDATE workflow_jobs SET status='CANCELLED',locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
         finished_at=now(),updated_at=now() WHERE id=$1 AND status IN ('QUEUED','RUNNING') RETURNING *`,
        [jobId],
      );
      if (!row.rows[0]) throw Object.assign(new Error('Job not found or already terminal'), { code: 'STATE_CONFLICT' });
      await client.query("INSERT INTO workflow_job_events (job_id,event_type) VALUES ($1,'JOB_CANCELLED')", [jobId]);
      return row.rows[0];
    });
  }

  async get(jobId) {
    const result = await this.pool.query('SELECT * FROM workflow_jobs WHERE id=$1', [jobId]);
    return result.rows[0] || null;
  }

  async list({ episodeId, status, limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be non-negative');
    const filters = [];
    const values = [];
    if (episodeId) { values.push(episodeId); filters.push(`episode_id=$${values.length}`); }
    if (status) {
      if (!JOB_STATES.includes(status)) throw new TypeError('Unknown job status');
      values.push(status); filters.push(`status=$${values.length}`);
    }
    values.push(limit); const limitPos=values.length;
    values.push(offset); const offsetPos=values.length;
    const result = await this.pool.query(
      `SELECT * FROM workflow_jobs ${filters.length ? 'WHERE '+filters.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${limitPos} OFFSET $${offsetPos}`, values,
    );
    return result.rows;
  }

  async #finish(jobId, status, { result: payload = null } = {}) {
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE workflow_jobs SET status=$1,result=$2::jsonb,locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,
         lease_expires_at=NULL,finished_at=now(),updated_at=now()
         WHERE id=$3 AND status='RUNNING' AND locked_by=$4 AND lease_expires_at > now() RETURNING *`,
        [status, JSON.stringify(payload), jobId, this.workerId],
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Job lease is no longer owned by this worker'), { code: 'LEASE_LOST' });
      await client.query(
        'INSERT INTO workflow_job_events (job_id,event_type,details) VALUES ($1,$2,$3::jsonb)',
        [jobId, status === 'SUCCEEDED' ? 'JOB_SUCCEEDED' : 'JOB_FINISHED', JSON.stringify({ workerId: this.workerId })],
      );
      return updated.rows[0];
    });
  }

  async withTransaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { DurableJobQueue, JOB_STATES };
