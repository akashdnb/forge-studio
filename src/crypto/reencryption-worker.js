'use strict';

const { randomUUID } = require('node:crypto');
const { KeyManagementService, fail } = require('./key-management');

class ReencryptionJobService {
  constructor({ pool, kms, workerId = `crypto-worker-${randomUUID()}`, leaseSeconds = 120 } = {}) {
    if (!pool?.connect) throw new TypeError('pool is required');
    if (!kms) throw new TypeError('kms is required');
    this.pool = pool;
    this.kms = kms;
    this.workerId = workerId;
    this.leaseSeconds = leaseSeconds;
  }

  async enqueue({ tenantId, projectId = null, purpose, sourceEpoch, targetEpoch, targetType, actor = 'system', maxAttempts = 10 }) {
    if (Number(targetEpoch) <= Number(sourceEpoch)) throw fail('target epoch must be newer than source epoch', 'INVALID_REENCRYPTION_RANGE', 422);
    const row = (await this.pool.query(`INSERT INTO forge_crypto_reencryption_jobs(tenant_id,project_id,purpose,source_epoch,target_epoch,target_type,max_attempts,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`, [tenantId, projectId, purpose, sourceEpoch, targetEpoch, targetType, maxAttempts, actor])).rows[0];
    return row || (await this.pool.query(`SELECT * FROM forge_crypto_reencryption_jobs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND source_epoch=$4 AND target_epoch=$5 AND target_type=$6 ORDER BY created_at DESC LIMIT 1`, [tenantId, projectId, purpose, sourceEpoch, targetEpoch, targetType])).rows[0];
  }

  async claim() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT * FROM forge_crypto_reencryption_jobs WHERE status IN ('PENDING','RETRY','RUNNING') AND next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      const claimed = (await client.query(`UPDATE forge_crypto_reencryption_jobs SET status='RUNNING',attempts=attempts+1,locked_by=$1,locked_until=now()+($2::int*interval '1 second'),started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$3 RETURNING *`, [this.workerId, this.leaseSeconds, row.id])).rows[0];
      await client.query('COMMIT');
      return claimed;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async succeed(jobId, { processed = 0 } = {}) {
    return (await this.pool.query(`UPDATE forge_crypto_reencryption_jobs SET status='SUCCEEDED',processed_count=processed_count+$1,locked_by=NULL,locked_until=NULL,completed_at=now(),updated_at=now() WHERE id=$2 AND locked_by=$3 RETURNING *`, [processed, jobId, this.workerId])).rows[0];
  }

  async failJob(jobId, error) {
    const row = (await this.pool.query(`SELECT attempts,max_attempts FROM forge_crypto_reencryption_jobs WHERE id=$1 AND locked_by=$2`, [jobId, this.workerId])).rows[0];
    if (!row) return null;
    const terminal = Number(row.attempts) >= Number(row.max_attempts);
    return (await this.pool.query(`UPDATE forge_crypto_reencryption_jobs SET status=$1,last_error_code=$2,last_error_message=$3,failed_count=failed_count+1,locked_by=NULL,locked_until=NULL,next_attempt_at=now()+($4::int*interval '1 second'),updated_at=now() WHERE id=$5 AND locked_by=$6 RETURNING *`, [terminal ? 'FAILED' : 'RETRY', error?.code || 'REENCRYPTION_FAILED', String(error?.message || 're-encryption failed').slice(0, 500), Math.min(3600, 2 ** Math.min(Number(row.attempts), 10)), jobId, this.workerId])).rows[0];
  }

  async runOne(job, handlers = {}) {
    if (!job) return null;
    const handler = handlers[job.target_type];
    if (typeof handler !== 'function') throw fail(`no re-encryption handler for ${job.target_type}`, 'REENCRYPTION_HANDLER_MISSING', 500);
    try {
      const processed = await KeyManagementService.withContext({ tenantId: job.tenant_id, projectId: job.project_id, purpose: job.purpose }, () => handler(job, this.kms));
      return this.succeed(job.id, { processed: Number(processed || 0) });
    } catch (error) {
      await this.failJob(job.id, error);
      throw error;
    }
  }
}

module.exports = { ReencryptionJobService };
