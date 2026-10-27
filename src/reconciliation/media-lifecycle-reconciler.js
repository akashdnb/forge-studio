const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { verifyPackageIntegrity } = require('../attestation/package-integrity');
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const NON_TERMINAL = new Set(['QUEUED', 'RUNNING']);
const IMMUTABLE_KINDS = new Set(['render', 'audio', 'image', 'caption', 'package']);
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function json(value) { return JSON.stringify(value ?? {}); }
function isSuperseded(job) { return job?.payload?.lifecycleState === 'SUPERSEDED' || job?.payload?.superseded === true; }
function isCancelled(job) { return job?.status === 'CANCELLED' || job?.payload?.lifecycleState === 'CANCELLED' || job?.payload?.cancelled === true; }
function terminalIntent(job) { const requested = job?.result?.terminalStatus || job?.payload?.terminalStatus; return TERMINAL.has(requested) ? requested : null; }
async function consume(stream, signal) { if (!stream) return; for await (const chunk of stream) { if (signal?.aborted) throw Object.assign(new Error('Reconciliation cancelled'), { code: 'CANCELLED' }); void chunk; } }

class MediaLifecycleReconciler {
  constructor({ pool, storage, workerId = `forge-reconciler:${randomUUID()}`, scanLimit = 50, recentWindowMinutes = 60, partialMaxAgeMinutes = 60, signal, logger = console } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required'); if (!storage) throw new TypeError('storage is required');
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 500) throw new TypeError('scanLimit must be 1..500'); if (!Number.isInteger(recentWindowMinutes) || recentWindowMinutes < 1) throw new TypeError('recentWindowMinutes must be positive');
    this.pool = pool; this.storage = storage; this.workerId = workerId; this.scanLimit = scanLimit; this.recentWindowMinutes = recentWindowMinutes; this.partialMaxAgeMinutes = partialMaxAgeMinutes; this.signal = signal; this.logger = logger;
  }
  async verifyArtifact(artifact) {
    if (!artifact?.id || !artifact.storage_key || !artifact.content_hash) return { healthy: false, code: 'ARTIFACT_NOT_FOUND', reason: 'trusted storage metadata missing' };
    if (artifact.version_episode_id !== artifact.episode_id) return { healthy: false, code: 'INVALID_PROVENANCE', reason: 'artifact/version episode mismatch' };
    const inputVersionIds = Array.isArray(artifact.input_version_ids) ? artifact.input_version_ids : [];
    if (inputVersionIds.length) { const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM version_records WHERE episode_id=$1 AND id=ANY($2::text[])', [artifact.episode_id, inputVersionIds]); if (Number(result.rows[0]?.count || 0) !== inputVersionIds.length) return { healthy: false, code: 'INVALID_PROVENANCE', reason: 'artifact references a missing or cross-episode input version' }; }
    if (artifact.stored_hash && artifact.stored_hash !== artifact.content_hash) return { healthy: false, code: 'CHECKSUM_MISMATCH', reason: 'database storage checksum differs from artifact checksum' };
    if (artifact.kind === 'package') {
      try { const integrity = await verifyPackageIntegrity({ pool: this.pool, packageArtifactId: artifact.id }); if (!integrity.ok) return { healthy: false, code: integrity.diagnostics[0]?.code || 'PACKAGE_ATTESTATION_BLOCKED', reason: 'package attestation/integrity verification failed', diagnostics: integrity.diagnostics }; }
      catch (error) { return { healthy: false, code: error.code || 'PACKAGE_ATTESTATION_BLOCKED', reason: error.message }; }
    }
    try { const resolved = await this.storage.download({ key: artifact.storage_key, expectedSha256: artifact.content_hash }); await consume(resolved.stream, this.signal); return { healthy: true, code: 'HEALTHY' }; }
    catch (error) { return { healthy: false, code: error.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND' : error.code === 'CHECKSUM_MISMATCH' ? 'CHECKSUM_MISMATCH' : 'ARTIFACT_CORRUPT', reason: error.message }; }
  }
  async recordRepair(client, runId, item) {
    const fingerprint = sha(json({ episodeId: item.episodeId, jobId: item.jobId, artifactId: item.artifactId, action: item.action, fromState: item.fromState, toState: item.toState, diagnostic: item.diagnostic }));
    const result = await client.query(`INSERT INTO forge_reconciliation_repairs (id,run_id,fingerprint,episode_id,job_id,artifact_id,action,from_state,to_state,severity,diagnostics) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (fingerprint) DO NOTHING RETURNING id`, [randomUUID(), runId, fingerprint, item.episodeId || null, item.jobId || null, item.artifactId || null, item.action, item.fromState || null, item.toState || null, item.severity || 'INFO', json(item.diagnostic)]);
    return Boolean(result.rows[0]);
  }
  async reconcileJob(client, runId, job) {
    if (this.signal?.aborted) throw Object.assign(new Error('Reconciliation cancelled'), { code: 'CANCELLED' }); let repaired = 0;
    if (job.status === 'RUNNING' && job.leased_until && new Date(job.leased_until) < new Date() && !isCancelled(job) && !isSuperseded(job)) {
      const updated = await client.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=now(),error=$1::jsonb,updated_at=now() WHERE id=$2 AND status='RUNNING' AND leased_until < now() RETURNING status`, [json({ code: 'STALE_LEASE_RECOVERED', message: 'Worker lease expired; job returned to the durable queue' }), job.id]);
      if (updated.rows[0] && await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, action: 'RECOVER_STALE_LEASE', fromState: 'RUNNING', toState: 'QUEUED', severity: 'RECOVERABLE', diagnostic: { workerId: job.worker_id } })) repaired++;
    }
    if (job.finished_at && NON_TERMINAL.has(job.status)) {
      const intended = terminalIntent(job); const next = intended === 'CANCELLED' && !isSuperseded(job) ? 'CANCELLED' : intended === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
      if (next === 'SUCCEEDED') {
        const expectedIds = Array.isArray(job.result?.artifactIds) ? job.result.artifactIds : [];
        const artifacts = expectedIds.length ? await client.query(`SELECT a.*,e.project_id,v.episode_id AS version_episode_id,s.storage_key,s.status,s.content_hash AS stored_hash FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN version_records v ON v.id=a.version_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=ANY($1::text[])`, [expectedIds]) : { rows: [] };
        const missing = expectedIds.find((id) => !artifacts.rows.find((row) => row.id === id));
        let invalid = null;
        if (!missing) for (const artifact of artifacts.rows) { const check = await this.verifyArtifact(artifact); if (!check.healthy) { invalid = { artifact, check }; break; } }
        if (missing || invalid) {
          const diagnostic = missing ? { code: 'MISSING_EXPECTED_ARTIFACT', artifactId: missing } : invalid.check;
          await client.query(`UPDATE forge_jobs SET status='FAILED',error=$1::jsonb,worker_id=NULL,leased_until=NULL,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$2 AND status IN ('QUEUED','RUNNING')`, [json(diagnostic), job.id]);
          if (await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, artifactId: invalid?.artifact?.id || missing, action: 'REPAIR_TERMINAL_SUCCESS_TO_FAILED', fromState: job.status, toState: 'FAILED', severity: 'PERMANENT', diagnostic })) repaired++;
        } else {
          const updated = await client.query(`UPDATE forge_jobs SET status='SUCCEEDED',worker_id=NULL,leased_until=NULL,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$1 AND status IN ('QUEUED','RUNNING') RETURNING id`, [job.id]);
          if (updated.rows[0] && await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, action: 'REPAIR_TERMINAL_STATE', fromState: job.status, toState: 'SUCCEEDED', severity: 'RECOVERABLE', diagnostic: { verifiedArtifactIds: expectedIds } })) repaired++;
        }
      } else {
        const updated = await client.query(`UPDATE forge_jobs SET status=$1,worker_id=NULL,leased_until=NULL,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$2 AND status IN ('QUEUED','RUNNING') RETURNING status`, [next, job.id]);
        if (updated.rows[0] && await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, action: 'REPAIR_TERMINAL_STATE', fromState: job.status, toState: next, severity: next === 'FAILED' ? 'PERMANENT' : 'RECOVERABLE', diagnostic: { intended: intended || 'FAILED' } })) repaired++;
      }
    }
    const artifactIds = new Set(Array.isArray(job.result?.artifactIds) ? job.result.artifactIds : []);
    if (job.episode_id) {
      const refs = await client.query(`SELECT a.*,e.project_id,v.episode_id AS version_episode_id,s.storage_key,s.status,s.content_hash AS stored_hash FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN version_records v ON v.id=a.version_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.episode_id=$1 AND (a.id=ANY($2::text[]) OR a.kind IN ('render','audio','caption','package')) ORDER BY a.created_at DESC LIMIT $3`, [job.episode_id, [...artifactIds], Math.min(this.scanLimit, 100)]);
      for (const artifact of refs.rows) {
        if (this.signal?.aborted) throw Object.assign(new Error('Reconciliation cancelled'), { code: 'CANCELLED' }); const check = await this.verifyArtifact(artifact);
        if (!check.healthy) {
          const status = check.code === 'ARTIFACT_NOT_FOUND' ? 'MISSING' : 'CORRUPT'; await client.query('UPDATE storage_objects SET status=$1,checksum_verified=false WHERE artifact_id=$2', [status, artifact.id]);
          if (job.status === 'SUCCEEDED' && !isCancelled(job) && !isSuperseded(job)) {
            const updated = await client.query(`UPDATE forge_jobs SET status='FAILED',error=$1::jsonb,finished_at=COALESCE(finished_at,now()),updated_at=now() WHERE id=$2 AND status='SUCCEEDED' RETURNING id`, [json({ code: check.code, message: check.reason }), job.id]);
            if (updated.rows[0] && await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, artifactId: artifact.id, action: 'FAIL_JOB_FOR_INVALID_ARTIFACT', fromState: 'SUCCEEDED', toState: 'FAILED', severity: 'PERMANENT', diagnostic: check })) repaired++;
          } else if (await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, artifactId: artifact.id, action: 'MARK_ARTIFACT_INVALID', severity: check.code === 'CHECKSUM_MISMATCH' ? 'PERMANENT' : 'RECOVERABLE', diagnostic: check })) repaired++;
        } else if (artifact.status !== 'READY' || artifact.stored_hash !== artifact.content_hash) {
          await client.query("UPDATE storage_objects SET status='READY',checksum_verified=true,content_hash=$1 WHERE artifact_id=$2", [artifact.content_hash, artifact.id]);
          if (await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, artifactId: artifact.id, action: 'RESTORE_STORAGE_HEALTH', toState: 'READY', severity: 'RECOVERABLE', diagnostic: { verified: true } })) repaired++;
        }
      }
      const duplicates = await client.query(`SELECT kind,version_id,COALESCE(metadata->>'logicalOutputKey',kind || ':' || version_id) AS logical_key,COUNT(*)::int AS count,MIN(id) AS canonical_id FROM artifacts WHERE episode_id=$1 AND kind=ANY($2::text[]) GROUP BY kind,version_id,COALESCE(metadata->>'logicalOutputKey',kind || ':' || version_id) HAVING COUNT(*) > 1 LIMIT $3`, [job.episode_id, [...IMMUTABLE_KINDS], this.scanLimit]);
      for (const duplicate of duplicates.rows) if (await this.recordRepair(client, runId, { jobId: job.id, episodeId: job.episode_id, action: 'FLAG_DUPLICATE_LOGICAL_OUTPUT', severity: 'CONFLICT', diagnostic: duplicate })) repaired++;
    }
    return repaired;
  }
  async run({ reason = 'scheduled' } = {}) {
    const runId = randomUUID(); await this.pool.query('INSERT INTO forge_reconciliation_runs(id,worker_id,status,diagnostics) VALUES($1,$2,\'RUNNING\',$3::jsonb)', [runId, this.workerId, json({ reason, scanLimit: this.scanLimit })]); const client = await this.pool.connect(); let scanned = 0; let repaired = 0;
    try {
      await client.query('BEGIN'); const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('forge-media-reconciliation')) AS locked");
      if (!lock.rows[0]?.locked) { await client.query('ROLLBACK'); await this.pool.query('UPDATE forge_reconciliation_runs SET status=\'CANCELLED\',finished_at=now(),diagnostics=$1::jsonb WHERE id=$2', [json({ reason: 'concurrent-run' }), runId]); return { status: 'SKIPPED_CONCURRENT', scanned: 0, repaired: 0 }; }
      const jobs = await client.query(`SELECT * FROM forge_jobs WHERE status IN ('QUEUED','RUNNING') OR (finished_at >= now() - ($1::text || ' minutes')::interval) ORDER BY updated_at DESC LIMIT $2 FOR UPDATE SKIP LOCKED`, [this.recentWindowMinutes, this.scanLimit]);
      for (const job of jobs.rows) { repaired += await this.reconcileJob(client, runId, job); scanned++; }
      if (this.storage.cleanupPartials) { const cleaned = await this.storage.cleanupPartials({ maxAgeMs: this.partialMaxAgeMinutes * 60 * 1000, maxFiles: this.scanLimit, signal: this.signal }); repaired += Number(cleaned?.removed || 0); }
      await client.query('UPDATE forge_reconciliation_runs SET status=\'SUCCEEDED\',finished_at=now(),scanned_count=$1,repaired_count=$2,diagnostics=$3::jsonb WHERE id=$4', [scanned, repaired, json({ reason, bounded: true }), runId]); await client.query('COMMIT'); return { status: 'SUCCEEDED', runId, scanned, repaired };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} await this.pool.query('UPDATE forge_reconciliation_runs SET status=$1,finished_at=now(),scanned_count=$2,repaired_count=$3,diagnostics=$4::jsonb WHERE id=$5', [error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', scanned, repaired, json({ code: error.code || 'RECONCILIATION_FAILED', message: error.message }), runId]).catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
function createMediaLifecycleReconciliationHandler(options) { return async (payload = {}, job = {}) => new MediaLifecycleReconciler({ ...options, workerId: `${options.workerId || 'forge-worker'}:job:${job.id || randomUUID()}` }).run({ reason: payload.reason || 'on-demand' }); }
module.exports = { MediaLifecycleReconciler, createMediaLifecycleReconciliationHandler, TERMINAL, consume };