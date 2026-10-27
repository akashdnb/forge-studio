const { randomUUID } = require('node:crypto');

class JobQueue {
  constructor({ pool, leaseSeconds = 300 }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new TypeError('leaseSeconds must be >= 10');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }
  async enqueue({ id = randomUUID(), projectId = null, episodeId = null, kind, payload = {}, priority = 100, maxAttempts = 3, idempotencyKey = id, createdBy = 'system', availableAt = null, dependsOnJobId = null }) {
    if (!kind || typeof kind !== 'string') throw new TypeError('kind is required');
    if (!Number.isInteger(priority) || priority < 0) throw new TypeError('priority must be a non-negative integer');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError('maxAttempts must be 1..10');
    const result = await this.pool.query(`INSERT INTO forge_jobs (id,project_id,episode_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_by,depends_on_job_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,COALESCE($8,now()),$9,$10,$11)
      ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=forge_jobs.updated_at RETURNING *`, [id, projectId, episodeId, kind, JSON.stringify(payload), priority, maxAttempts, availableAt, idempotencyKey, createdBy, dependsOnJobId]);
    return result.rows[0];
  }
  async get(id) { const result = await this.pool.query('SELECT * FROM forge_jobs WHERE id=$1', [id]); return result.rows[0] || null; }
  async list({ projectId = null, episodeId = null, status = null, limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be non-negative');
    const values = []; const where = [];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (episodeId) { values.push(episodeId); where.push(`episode_id=$${values.length}`); }
    if (status) { values.push(status); where.push(`status=$${values.length}`); }
    values.push(limit, offset);
    const result = await this.pool.query(`SELECT * FROM forge_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority ASC, created_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return result.rows;
  }
  async recoverBlockedDependencies() {
    const result = await this.pool.query(`UPDATE forge_jobs j SET status='CANCELLED',error=jsonb_build_object('message','Dependency failed or was cancelled'),finished_at=now(),updated_at=now()
      FROM forge_jobs d WHERE j.status='QUEUED' AND j.depends_on_job_id=d.id AND d.status IN ('FAILED','CANCELLED') RETURNING j.id`);
    return result.rowCount;
  }
  async claim({ workerId, kinds = [], now = new Date() }) {
    if (!workerId) throw new TypeError('workerId is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const params = [now, this.leaseSeconds, workerId]; let kindFilter = '';
      if (kinds.length) { params.push(kinds); kindFilter = `AND j.kind = ANY($${params.length}::text[])`; }
      const result = await client.query(`WITH candidate AS (SELECT j.id FROM forge_jobs j WHERE j.status='QUEUED' AND j.available_at <= $1 AND (j.leased_until IS NULL OR j.leased_until < $1) ${kindFilter}
        AND (j.depends_on_job_id IS NULL OR EXISTS (SELECT 1 FROM forge_jobs d WHERE d.id=j.depends_on_job_id AND d.status='SUCCEEDED')) ORDER BY j.priority ASC,j.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE forge_jobs j SET status='RUNNING',attempts=j.attempts+1,worker_id=$3,leased_until=$1+($2::text||' seconds')::interval,started_at=COALESCE(j.started_at,now()),updated_at=now() FROM candidate c WHERE j.id=c.id RETURNING j.*`, params);
      await client.query('COMMIT'); return result.rows[0] || null;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async claimSpecific(id, workerId, now = new Date()) {
    if (!id || !workerId) throw new TypeError('id and workerId are required');
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await client.query(`UPDATE forge_jobs j SET status='RUNNING',attempts=j.attempts+1,worker_id=$2,leased_until=$3+($4::text||' seconds')::interval,started_at=COALESCE(j.started_at,now()),updated_at=now()
      WHERE j.id=$1 AND j.status='QUEUED' AND j.available_at <= $3 AND (j.leased_until IS NULL OR j.leased_until < $3) AND (j.depends_on_job_id IS NULL OR EXISTS (SELECT 1 FROM forge_jobs d WHERE d.id=j.depends_on_job_id AND d.status='SUCCEEDED')) RETURNING j.*`, [id, workerId, now, this.leaseSeconds]); await client.query('COMMIT'); return result.rows[0] || null; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async heartbeat(id, workerId) { const result = await this.pool.query(`UPDATE forge_jobs SET leased_until=now()+($1::text||' seconds')::interval,updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 RETURNING *`, [this.leaseSeconds, id, workerId]); return result.rows[0] || null; }
  async succeed(id, workerId, result = {}) { const updated = await this.pool.query(`UPDATE forge_jobs SET status='SUCCEEDED',result=$1::jsonb,leased_until=NULL,finished_at=now(),updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 RETURNING *`, [JSON.stringify(result), id, workerId]); if (!updated.rows[0]) throw new Error(`Job ${id} is not owned by worker ${workerId}`); return updated.rows[0]; }
  async cancel(id, workerId, reason = 'Cancelled by admission control') { const updated = await this.pool.query(`UPDATE forge_jobs SET status='CANCELLED',leased_until=NULL,error=$1::jsonb,finished_at=now(),updated_at=now() WHERE id=$2 AND status='RUNNING' AND worker_id=$3 RETURNING *`, [JSON.stringify({ message: reason }), id, workerId]); if (!updated.rows[0]) throw new Error(`Job ${id} is not owned by worker ${workerId}`); return updated.rows[0]; }
  async fail(id, workerId, error, { retry = true, delaySeconds = 30 } = {}) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const current = await client.query('SELECT * FROM forge_jobs WHERE id=$1 FOR UPDATE', [id]); const job = current.rows[0];
      if (!job || job.status !== 'RUNNING' || job.worker_id !== workerId) throw new Error(`Job ${id} is not owned by worker ${workerId}`); const canRetry = retry && job.attempts < job.max_attempts;
      const updated = await client.query(canRetry ? `UPDATE forge_jobs SET status='QUEUED',available_at=now()+($1::text||' seconds')::interval,leased_until=NULL,worker_id=NULL,error=$2::jsonb,updated_at=now() WHERE id=$3 RETURNING *` : `UPDATE forge_jobs SET status='FAILED',leased_until=NULL,error=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$3 RETURNING *`, canRetry ? [Math.max(1, delaySeconds), JSON.stringify({ message: error?.message || String(error) }), id] : [null, JSON.stringify({ message: error?.message || String(error) }), id]);
      await client.query('COMMIT'); return updated.rows[0];
    } catch (err) { try { await client.query('ROLLBACK'); } catch {} throw err; } finally { client.release(); }
  }
  async recoverExpiredLeases() { const result = await this.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=now(),updated_at=now() WHERE status='RUNNING' AND leased_until<now() RETURNING id`); return result.rowCount; }
}
module.exports = { JobQueue };
