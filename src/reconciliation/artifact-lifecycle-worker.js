const { randomUUID, createHash } = require('node:crypto');

const STATES = new Set(['RETAINED', 'QUARANTINED', 'DELETION_PENDING', 'DELETED', 'PROTECTED']);
const ACTIVE_EPISODE_STATES = new Set(['DRAFT','RESEARCHING','SCRIPT_DRAFT','SCRIPT_REVIEW','SCRIPT_APPROVED','PLANNING','PLAN_REVIEW','GENERATION','READY_TO_RENDER','RENDERING','QA','AWAITING_APPROVAL','APPROVED','PUBLISHING']);
const DEFAULT_RETENTION_DAYS = { render: 90, package: 365, audio: 90, image: 90, video: 90, caption: 90, 'render-manifest': 90, default: 30 };

function json(value) { return JSON.stringify(value ?? {}); }
function fingerprint(value) { return createHash('sha256').update(json(value)).digest('hex'); }
function cancelled(signal) { return Boolean(signal?.aborted); }
function cancellationError() { return Object.assign(new Error('Artifact lifecycle run cancelled'), { code: 'CANCELLED', retryable: false }); }
async function withTimeout(operation, timeoutMs, signal) {
  if (cancelled(signal)) throw cancellationError();
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Artifact storage operation timed out after ${timeoutMs}ms`), { code: 'STORAGE_TIMEOUT', retryable: true })), timeoutMs);
    timer.unref?.();
  });
  const abort = new Promise((_, reject) => {
    if (!signal) return;
    abortHandler = () => reject(cancellationError());
    signal.addEventListener('abort', abortHandler, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), timeout, abort]); }
  finally { clearTimeout(timer); if (signal && abortHandler) signal.removeEventListener('abort', abortHandler); }
}

class ArtifactLifecycleWorker {
  constructor({
    pool,
    storage,
    workerId = `forge-artifact-lifecycle:${randomUUID()}`,
    scanLimit = 50,
    quarantineGraceMinutes = 1440,
    recoveryWindowMinutes = 1440,
    deleteTimeoutMs = 120000,
    retentionDays = {},
    signal,
    logger = console,
  } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    if (!storage || typeof storage.delete !== 'function') throw new TypeError('storage backend with delete() is required');
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 500) throw new TypeError('scanLimit must be 1..500');
    if (!Number.isInteger(quarantineGraceMinutes) || quarantineGraceMinutes < 0) throw new TypeError('quarantineGraceMinutes must be non-negative');
    if (!Number.isInteger(recoveryWindowMinutes) || recoveryWindowMinutes < 0) throw new TypeError('recoveryWindowMinutes must be non-negative');
    this.pool = pool; this.storage = storage; this.workerId = workerId; this.scanLimit = scanLimit;
    this.quarantineGraceMinutes = quarantineGraceMinutes; this.recoveryWindowMinutes = recoveryWindowMinutes; this.deleteTimeoutMs = deleteTimeoutMs;
    this.retentionDays = { ...DEFAULT_RETENTION_DAYS, ...retentionDays }; this.signal = signal; this.logger = logger;
  }

  retentionFor(kind) {
    const days = Number(this.retentionDays[kind] ?? this.retentionDays.default);
    if (!Number.isFinite(days) || days < 0) throw new TypeError(`Invalid retention policy for ${kind}`);
    return days;
  }

  async ensureLifecycle(client, artifact) {
    await client.query(`INSERT INTO artifact_lifecycle_records (artifact_id,project_id,state,metadata)
      VALUES ($1,$2,'RETAINED',$3::jsonb) ON CONFLICT (artifact_id) DO NOTHING`, [artifact.id, artifact.project_id, json({ initializedBy: this.workerId })]);
  }

  async evaluateReferences(client, artifact) {
    const params = [artifact.id, artifact.version_id, artifact.episode_id];
    const direct = await client.query(`
      SELECT
        (SELECT count(*) FROM version_dependencies vd WHERE vd.depends_on_version_id=$2) AS dependency_refs,
        (SELECT count(*) FROM artifacts ai WHERE ai.id<>$1 AND ai.input_version_ids ? $2) AS input_version_refs,
        (SELECT count(*) FROM approvals ap WHERE ap.target_version_id=$2 AND ap.decision='APPROVED') AS approval_refs,
        (SELECT count(*) FROM qa_results qr WHERE (qr.artifact_id=$1 OR qr.version_id=$2) AND qr.status IN ('PASSED','WARNINGS')) AS qa_refs,
        (SELECT count(*) FROM publish_runs pr WHERE pr.status IN ('QUEUED','UPLOADING','PUBLISHED') AND (pr.render_artifact_id=$1 OR pr.render_version_id=$2 OR pr.package_artifact_id=$1 OR pr.package_version_id=$2)) AS publish_refs,
        (SELECT count(*) FROM episode_packages ep WHERE ep.status IN ('READY','RECONCILING') AND (ep.final_media_artifact_id=$1 OR ep.final_media_version_id=$2 OR ep.version_id=$2)) AS package_refs,
        (SELECT count(*) FROM episodes e WHERE e.id=$3 AND (e.current_render_id=$1 OR e.approved_render_id=$1 OR e.current_versions::text LIKE '%'||$2||'%')) AS episode_refs,
        (SELECT count(*) FROM forge_jobs j WHERE j.status IN ('QUEUED','RUNNING') AND (j.payload::text LIKE '%'||$1||'%' OR j.result::text LIKE '%'||$1||'%')) AS active_job_refs,
        (SELECT count(*) FROM provider_runs pr WHERE pr.status IN ('QUEUED','RUNNING') AND (pr.input_version_ids ? $2 OR pr.result_artifact_ids ? $1)) AS active_provider_refs,
        (SELECT count(*) FROM artifact_holds h WHERE h.artifact_id=$1 AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now())) AS hold_refs,
        (SELECT count(*) FROM episodes e WHERE e.id=$3 AND e.state=ANY($4::text[])) AS active_episode_refs`, [...params, [...ACTIVE_EPISODE_STATES]]);
    const row = direct.rows[0] || {};
    const dependencyRefs = Number(row.dependency_refs || 0) + Number(row.input_version_refs || 0);
    const workflowRefs = Number(row.active_job_refs || 0) + Number(row.active_provider_refs || 0);
    const protectedRefs = Number(row.approval_refs || 0) + Number(row.qa_refs || 0) + Number(row.publish_refs || 0) + Number(row.package_refs || 0) + Number(row.episode_refs || 0) + Number(row.hold_refs || 0);

    const reachable = await client.query(`WITH RECURSIVE reachable(id) AS (
      SELECT $2::text
      WHERE EXISTS (
        SELECT 1 FROM episodes e WHERE e.id=$3 AND (
          e.current_render_id=$1 OR e.approved_render_id=$1 OR e.current_versions::text LIKE '%'||$2||'%'
        )
      )
      UNION
      SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN reachable r ON r.id=vd.version_id
      UNION
      SELECT ap.target_version_id FROM approvals ap WHERE ap.episode_id=$3 AND ap.decision='APPROVED'
      UNION
      SELECT qr.version_id FROM qa_results qr WHERE qr.episode_id=$3 AND qr.status IN ('PASSED','WARNINGS')
      UNION
      SELECT pr.render_version_id FROM publish_runs pr WHERE pr.episode_id=$3 AND pr.status IN ('QUEUED','UPLOADING','PUBLISHED')
      UNION
      SELECT pr.package_version_id FROM publish_runs pr WHERE pr.episode_id=$3 AND pr.status IN ('QUEUED','UPLOADING','PUBLISHED')
      UNION
      SELECT ep.final_media_version_id FROM episode_packages ep WHERE ep.episode_id=$3 AND ep.status IN ('READY','RECONCILING')
    ) SELECT EXISTS (SELECT 1 FROM reachable WHERE id=$2) AS reachable`, params);
    const reachableVersion = Boolean(reachable.rows[0]?.reachable);
    const protectedArtifact = Number(row.hold_refs || 0) > 0 || Number(row.approval_refs || 0) > 0 || Number(row.qa_refs || 0) > 0 || Number(row.publish_refs || 0) > 0 || Number(row.package_refs || 0) > 0 || reachableVersion || Number(row.active_episode_refs || 0) > 0;
    return { referenceCount: dependencyRefs + workflowRefs + protectedRefs, dependencyRefs, workflowRefs, protectedRefs, reachableVersion, protectedArtifact, activeJob: workflowRefs > 0, hold: Number(row.hold_refs || 0) > 0 };
  }

  async candidateExpired(client, artifact, lifecycle) {
    if (lifecycle.state === 'DELETED') return false;
    if (lifecycle.state === 'PROTECTED') return false;
    const retentionDays = this.retentionFor(artifact.kind);
    const result = await client.query(`SELECT a.created_at, s.expires_at, s.status, s.storage_key
      FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1`, [artifact.id]);
    const row = result.rows[0];
    if (!row?.storage_key || ['MISSING','CORRUPT'].includes(row.status)) return false;
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return true;
    return new Date(row.created_at).getTime() <= Date.now() - retentionDays * 86400000;
  }

  async recordEvent(client, runId, artifactId, action, fromState, toState, referenceCount, reason, diagnostics = {}) {
    await client.query(`INSERT INTO artifact_lifecycle_events(run_id,artifact_id,action,from_state,to_state,reference_count,reason,diagnostics)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [runId, artifactId, action, fromState, toState, referenceCount, reason, json(diagnostics)]);
  }

  async protect(client, runId, artifact, lifecycle, refs, reason) {
    const state = lifecycle.state === 'DELETED' ? lifecycle.state : 'PROTECTED';
    await client.query(`UPDATE artifact_lifecycle_records SET state=$1,reference_count=$2,protected_reason=$3,candidate_at=NULL,quarantine_at=NULL,deletion_pending_at=NULL,last_evaluated_at=now(),last_run_id=$4,last_error=NULL,updated_at=now() WHERE artifact_id=$5`, [state, refs.referenceCount, reason, runId, artifact.id]);
    await this.recordEvent(client, runId, artifact.id, 'PROTECTED', lifecycle.state, state, refs.referenceCount, reason, refs);
  }

  async quarantine(client, runId, artifact, lifecycle, refs) {
    if (lifecycle.state === 'DELETED') return;
    const candidateAt = lifecycle.candidate_at || new Date();
    if (lifecycle.state === 'QUARANTINED' && lifecycle.quarantine_at) return;
    await client.query(`UPDATE artifact_lifecycle_records SET state='QUARANTINED',reference_count=$1,candidate_at=$2,quarantine_at=COALESCE(quarantine_at,now()),protected_reason=NULL,last_evaluated_at=now(),last_run_id=$3,last_error=NULL,updated_at=now() WHERE artifact_id=$4 AND state NOT IN ('DELETED','DELETION_PENDING')`, [refs.referenceCount, candidateAt, runId, artifact.id]);
    await this.recordEvent(client, runId, artifact.id, 'QUARANTINED', lifecycle.state, 'QUARANTINED', refs.referenceCount, 'RETENTION_EXPIRED', { retentionDays: this.retentionFor(artifact.kind) });
  }

  async markDeletionPending(client, runId, artifact, lifecycle, refs) {
    const result = await client.query(`UPDATE artifact_lifecycle_records SET state='DELETION_PENDING',reference_count=$1,deletion_pending_at=now(),last_evaluated_at=now(),last_run_id=$2,updated_at=now() WHERE artifact_id=$3 AND state='QUARANTINED' AND quarantine_at <= now() - ($4::text || ' minutes')::interval RETURNING *`, [refs.referenceCount, runId, artifact.id, this.quarantineGraceMinutes]);
    if (result.rows[0]) await this.recordEvent(client, runId, artifact.id, 'DELETION_PENDING', lifecycle.state, 'DELETION_PENDING', refs.referenceCount, 'QUARANTINE_GRACE_ELAPSED');
    return result.rows[0] || null;
  }

  async deleteOne(runId, artifactId) {
    const client = await this.pool.connect();
    let artifact = null;
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT a.*,e.project_id,s.storage_key,l.state,l.quarantine_at,l.deletion_pending_at
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id LEFT JOIN storage_objects s ON s.artifact_id=a.id
        JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE a.id=$1 FOR UPDATE OF l`, [artifactId]);
      artifact = locked.rows[0];
      if (!artifact || artifact.state !== 'DELETION_PENDING') { await client.query('ROLLBACK'); return { status: 'SKIPPED' }; }
      const refs = await this.evaluateReferences(client, artifact);
      const expired = await this.candidateExpired(client, artifact, artifact);
      if (refs.protectedArtifact || refs.activeJob || refs.hold || !expired) {
        await client.query(`UPDATE artifact_lifecycle_records SET state='PROTECTED',reference_count=$1,protected_reason=$2,last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$3`, [refs.referenceCount, refs.hold ? 'HOLD' : refs.activeJob ? 'ACTIVE_JOB' : 'REFERENCE_REAPPEARED', artifactId]);
        await this.recordEvent(client, runId, artifactId, 'PROTECTED', 'DELETION_PENDING', 'PROTECTED', refs.referenceCount, 'PRE_DELETE_RECHECK_FAILED', refs);
        await client.query('COMMIT'); return { status: 'PROTECTED' };
      }
      if (!artifact.storage_key) {
        await client.query(`UPDATE artifact_lifecycle_records SET state='DELETED',deleted_at=now(),last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$1`, [artifactId]);
        await this.recordEvent(client, runId, artifactId, 'DELETED', 'DELETION_PENDING', 'DELETED', refs.referenceCount, 'NO_STORAGE_OBJECT');
        await client.query('COMMIT'); return { status: 'DELETED', artifactId };
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      throw error;
    }
    client.release();

    try {
      await withTimeout(() => this.storage.delete(artifact.storage_key), this.deleteTimeoutMs, this.signal);
    } catch (error) {
      const failureClient = await this.pool.connect();
      try {
        await failureClient.query(`UPDATE artifact_lifecycle_records SET state='DELETION_PENDING',last_error=$1::jsonb,last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$2 AND state='DELETION_PENDING'`, [json({ code: error.code || 'STORAGE_DELETE_FAILED', message: error.message }), artifactId]);
        await failureClient.query(`INSERT INTO artifact_lifecycle_events(run_id,artifact_id,action,from_state,to_state,reference_count,reason,diagnostics) VALUES($1,$2,'DELETE_FAILED','DELETION_PENDING','DELETION_PENDING',0,$3,$4::jsonb)`, [runId, artifactId, error.code || 'STORAGE_DELETE_FAILED', json({ message: error.message })]);
      } finally { failureClient.release(); }
      return { status: 'FAILED', artifactId, error };
    }

    const finalize = await this.pool.connect();
    try {
      await finalize.query('BEGIN');
      const locked = await finalize.query('SELECT state FROM artifact_lifecycle_records WHERE artifact_id=$1 FOR UPDATE', [artifactId]);
      if (locked.rows[0]?.state === 'DELETION_PENDING') {
        const refs = await this.evaluateReferences(finalize, artifact);
        if (refs.protectedArtifact || refs.activeJob || refs.hold) {
          await finalize.query(`UPDATE artifact_lifecycle_records SET state='PROTECTED',reference_count=$1,protected_reason=$2,last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$3`, [refs.referenceCount, refs.hold ? 'HOLD' : refs.activeJob ? 'ACTIVE_JOB' : 'REFERENCE_REAPPEARED', artifactId]);
          await this.recordEvent(finalize, runId, artifactId, 'PROTECTED', 'DELETION_PENDING', 'PROTECTED', refs.referenceCount, 'POST_DELETE_RECHECK_FAILED', refs);
        } else {
          await finalize.query(`UPDATE artifact_lifecycle_records SET state='DELETED',reference_count=0,deleted_at=now(),last_error=NULL,last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$1`, [artifactId]);
          await finalize.query(`UPDATE storage_objects SET status='DELETED',checksum_verified=false WHERE artifact_id=$1`, [artifactId]);
          await this.recordEvent(finalize, runId, artifactId, 'DELETED', 'DELETION_PENDING', 'DELETED', refs.referenceCount, 'STORAGE_OBJECT_DELETED');
        }
      }
      await finalize.query('COMMIT');
      return { status: 'DELETED', artifactId };
    } catch (error) { try { await finalize.query('ROLLBACK'); } catch {} throw error; }
    finally { finalize.release(); }
  }

  async evaluateOne(client, runId, artifact, dryRun) {
    await this.ensureLifecycle(client, artifact);
    const lifecycleResult = await client.query('SELECT * FROM artifact_lifecycle_records WHERE artifact_id=$1 FOR UPDATE', [artifact.id]);
    const lifecycle = lifecycleResult.rows[0];
    const refs = await this.evaluateReferences(client, artifact);
    await client.query('UPDATE artifact_lifecycle_records SET reference_count=$1,last_evaluated_at=now(),last_run_id=$2,updated_at=now() WHERE artifact_id=$3', [refs.referenceCount, runId, artifact.id]);
    if (refs.protectedArtifact || refs.activeJob || refs.hold || ACTIVE_EPISODE_STATES.has(artifact.episode_state)) {
      if (!dryRun) await this.protect(client, runId, artifact, lifecycle, refs, refs.hold ? 'HOLD' : refs.activeJob ? 'ACTIVE_JOB' : refs.reachableVersion ? 'PROVENANCE_REACHABLE' : 'LIVE_EPISODE');
      else await this.recordEvent(client, runId, artifact.id, 'DRY_RUN', lifecycle.state, lifecycle.state, refs.referenceCount, 'PROTECTED', refs);
      return 'protected';
    }
    if (!(await this.candidateExpired(client, artifact, lifecycle))) {
      if (!dryRun && lifecycle.state === 'QUARANTINED') await client.query(`UPDATE artifact_lifecycle_records SET state='RETAINED',quarantine_at=NULL,candidate_at=NULL,last_evaluated_at=now(),updated_at=now() WHERE artifact_id=$1`, [artifact.id]);
      if (dryRun) await this.recordEvent(client, runId, artifact.id, 'DRY_RUN', lifecycle.state, lifecycle.state, refs.referenceCount, 'RETENTION_NOT_EXPIRED', { retentionDays: this.retentionFor(artifact.kind) });
      return 'retained';
    }
    if (dryRun) { await this.recordEvent(client, runId, artifact.id, 'DRY_RUN', lifecycle.state, lifecycle.state, refs.referenceCount, 'RETENTION_EXPIRED', { retentionDays: this.retentionFor(artifact.kind) }); return 'candidate'; }
    if (lifecycle.state === 'DELETION_PENDING') return 'deletion-pending';
    if (lifecycle.state !== 'QUARANTINED') { await this.quarantine(client, runId, artifact, lifecycle, refs); return 'quarantined'; }
    const pending = await this.markDeletionPending(client, runId, artifact, lifecycle, refs);
    return pending ? 'deletion-pending' : 'quarantined';
  }

  async run({ reason = 'scheduled', dryRun = false } = {}) {
    const runId = randomUUID();
    await this.pool.query(`INSERT INTO artifact_lifecycle_runs(id,worker_id,status,mode,reason,scan_limit) VALUES($1,$2,'RUNNING',$3,$4,$5)`, [runId, this.workerId, dryRun ? 'DRY_RUN' : 'ENFORCE', reason, this.scanLimit]);
    const client = await this.pool.connect();
    const counts = { scanned: 0, protected: 0, quarantined: 0, deletionPending: 0, deleted: 0, failed: 0 };
    try {
      await client.query('BEGIN');
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('forge-artifact-lifecycle-gc')) AS locked");
      if (!lock.rows[0]?.locked) { await client.query('ROLLBACK'); await this.pool.query("UPDATE artifact_lifecycle_runs SET status='SKIPPED_CONCURRENT',finished_at=now() WHERE id=$1", [runId]); return { status: 'SKIPPED_CONCURRENT', runId, ...counts }; }
      const candidates = await client.query(`SELECT a.*,e.project_id,e.state AS episode_state,s.storage_key,s.status AS storage_status,s.expires_at,l.state AS lifecycle_state,l.quarantine_at
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN storage_objects s ON s.artifact_id=a.id
        LEFT JOIN artifact_lifecycle_records l ON l.artifact_id=a.id
        WHERE s.storage_key IS NOT NULL AND (l.state IS NULL OR l.state IN ('RETAINED','PROTECTED','QUARANTINED','DELETION_PENDING'))
        ORDER BY a.created_at ASC,a.id ASC LIMIT $1 FOR UPDATE OF a SKIP LOCKED`, [this.scanLimit]);
      for (const artifact of candidates.rows) {
        if (cancelled(this.signal)) throw cancellationError();
        const result = await this.evaluateOne(client, runId, artifact, dryRun); counts.scanned++;
        if (result === 'protected') counts.protected++; else if (result === 'quarantined') counts.quarantined++; else if (result === 'deletion-pending') counts.deletionPending++;
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      await this.pool.query(`UPDATE artifact_lifecycle_runs SET status=$1,scanned_count=$2,protected_count=$3,quarantined_count=$4,deletion_pending_count=$5,deleted_count=$6,failed_count=$7,diagnostics=$8::jsonb,finished_at=now() WHERE id=$9`, [error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', counts.scanned, counts.protected, counts.quarantined, counts.deletionPending, counts.deleted, counts.failed, json({ code: error.code || 'LIFECYCLE_FAILED', message: error.message }), runId]);
      throw error;
    } finally { client.release(); }

    if (!dryRun) {
      const pending = await this.pool.query(`SELECT artifact_id FROM artifact_lifecycle_records WHERE state='DELETION_PENDING' ORDER BY deletion_pending_at ASC,artifact_id ASC LIMIT $1`, [this.scanLimit]);
      for (const row of pending.rows) {
        if (cancelled(this.signal)) throw cancellationError();
        const result = await this.deleteOne(runId, row.artifact_id);
        if (result.status === 'DELETED') counts.deleted++; else if (result.status === 'FAILED') counts.failed++;
      }
    }
    await this.pool.query(`UPDATE artifact_lifecycle_runs SET status='SUCCEEDED',scanned_count=$1,protected_count=$2,quarantined_count=$3,deletion_pending_count=$4,deleted_count=$5,failed_count=$6,diagnostics=$7::jsonb,finished_at=now() WHERE id=$8`, [counts.scanned, counts.protected, counts.quarantined, counts.deletionPending, counts.deleted, counts.failed, json({ bounded: true, workerId: this.workerId }), runId]);
    return { status: 'SUCCEEDED', runId, dryRun, ...counts };
  }
}

function parseRetentionPolicy(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Artifact retention policy must be an object');
  return parsed;
}
function createArtifactLifecycleHandler(options = {}) {
  return async (payload = {}, job = {}) => new ArtifactLifecycleWorker({ ...options, workerId: `${options.workerId || 'forge-worker'}:artifact-lifecycle:${job.id || randomUUID()}` }).run({ reason: payload.reason || 'on-demand', dryRun: payload.dryRun === true });
}
module.exports = { ArtifactLifecycleWorker, createArtifactLifecycleHandler, parseRetentionPolicy, STATES, ACTIVE_EPISODE_STATES, DEFAULT_RETENTION_DAYS, fingerprint };
