const { randomUUID, createHash } = require('node:crypto');

const DEFAULT_POLICY = Object.freeze({
  quarantineGraceMinutes: 1440,
  minAgeMinutes: 1440,
  scanLimit: 100,
  maxDeleteBytes: 1073741824,
  requireOperatorApproval: true,
});

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function json(value) { return JSON.stringify(value ?? {}); }
function cancelled(signal) { return Boolean(signal?.aborted); }
function cancellationError() { return Object.assign(new Error('artifact compaction cancelled'), { code: 'CANCELLED', retryable: false }); }

class ArtifactRetentionOptimizer {
  constructor({ pool, storage, workerId = `forge-artifact-optimizer:${randomUUID()}`, policy = {}, signal, logger = console, metrics = null } = {}) {
    if (!pool?.connect || !pool?.query) throw new TypeError('pg-compatible pool is required');
    if (!storage || typeof storage.delete !== 'function') throw new TypeError('storage backend with delete() is required');
    this.pool = pool; this.storage = storage; this.workerId = workerId;
    this.policy = { ...DEFAULT_POLICY, ...policy }; this.signal = signal; this.logger = logger; this.metrics = metrics;
  }
  _checkCancelled() { if (cancelled(this.signal)) throw cancellationError(); }

  async registerUploadedObject({ tenantId, projectId, artifactId, versionId, sha256, sizeBytes, mediaType, kind, storageKey, immutableEvidence = false, recoveryRequired = false, metadata = {} }) {
    if (!tenantId || !projectId || !artifactId || !versionId || !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('tenant, project, artifact, version and SHA-256 are required');
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('sizeBytes must be a safe non-negative integer');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope = await client.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR SHARE', [projectId, tenantId]);
      if (!scope.rows[0]) throw Object.assign(new Error('tenant/project mismatch'), { code: 'TENANT_SCOPE_VIOLATION' });
      const existing = await client.query('SELECT * FROM artifact_content_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE', [tenantId, sha256]);
      let object = existing.rows[0];
      if (object) {
        if (Number(object.size_bytes) !== sizeBytes) throw Object.assign(new Error('content-addressed object size mismatch'), { code: 'CHECKSUM_METADATA_MISMATCH' });
        if (object.status === 'DELETED') throw Object.assign(new Error('content-addressed object was deleted'), { code: 'OBJECT_TOMBSTONED' });
      } else {
        object = (await client.query(`INSERT INTO artifact_content_objects
          (id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,immutable_evidence,recovery_required,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,true,'READY',$8,$9,$10::jsonb) RETURNING *`,
          [randomUUID(), tenantId, sha256, sizeBytes, mediaType || 'application/octet-stream', kind || 'unknown', storageKey, immutableEvidence, recoveryRequired, json(metadata)])).rows[0];
      }
      const refKind = immutableEvidence ? 'IMMUTABLE' : (kind || '').startsWith('derivative:') ? 'DERIVED' : 'IMMUTABLE';
      const ref = await client.query(`INSERT INTO artifact_content_refs
        (id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active)
        VALUES($1,$2,$3,$4,$5,$6,$7,true)
        ON CONFLICT (artifact_id) DO UPDATE SET object_id=EXCLUDED.object_id,tenant_id=EXCLUDED.tenant_id,project_id=EXCLUDED.project_id,ref_kind=EXCLUDED.ref_kind,source_version_id=EXCLUDED.source_version_id,active=true,released_at=NULL
        RETURNING *`, [randomUUID(), tenantId, projectId, artifactId, object.id, refKind, versionId]);
      await client.query('COMMIT');
      this.metrics?.inc?.('forge_artifact_dedup_registrations_total', { outcome: existing.rows[0] ? 'deduplicated' : 'created' });
      return { object, ref: ref.rows[0], deduplicated: Boolean(existing.rows[0]) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async reserve({ tenantId, objectId, purpose, idempotencyKey, ttlMinutes = 30 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM artifact_storage_reservations WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE', [tenantId, idempotencyKey]);
      if (existing.rows[0]) { await client.query('COMMIT'); return existing.rows[0]; }
      const object = (await client.query('SELECT * FROM artifact_content_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [objectId, tenantId])).rows[0];
      if (!object || object.status === 'DELETED') throw Object.assign(new Error('content object unavailable'), { code: 'OBJECT_UNAVAILABLE' });
      const reservation = (await client.query(`INSERT INTO artifact_storage_reservations
        (id,tenant_id,object_id,bytes_reserved,state,purpose,idempotency_key,expires_at)
        VALUES($1,$2,$3,$4,'HELD',$5,$6,now()+($7::text||' minutes')::interval) RETURNING *`,
        [randomUUID(), tenantId, objectId, object.size_bytes, purpose, idempotencyKey, Math.max(1, ttlMinutes)])).rows[0];
      await client.query('COMMIT'); return reservation;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async releaseReservation({ tenantId, reservationId, state = 'RELEASED' }) {
    if (!['RELEASED', 'EXPIRED', 'COMMITTED'].includes(state)) throw new TypeError('invalid reservation terminal state');
    const result = await this.pool.query(`UPDATE artifact_storage_reservations SET state=$1,released_at=now(),committed_at=CASE WHEN $1='COMMITTED' THEN now() ELSE committed_at END WHERE id=$2 AND tenant_id=$3 AND state='HELD' RETURNING *`, [state, reservationId, tenantId]);
    return result.rows[0] || null;
  }

  async createPlan({ tenantId, createdBy, mode = 'DRY_RUN', policy = {}, reason = 'operator', scanLimit, maxDeleteBytes }) {
    if (!['DRY_RUN', 'ENFORCE'].includes(mode)) throw new TypeError('mode must be DRY_RUN or ENFORCE');
    if (!createdBy) throw new TypeError('createdBy is required');
    const snapshot = { ...this.policy, ...policy, scanLimit: scanLimit || this.policy.scanLimit, maxDeleteBytes: maxDeleteBytes ?? this.policy.maxDeleteBytes, reason, schemaVersion: 1 };
    const status = mode === 'ENFORCE' && snapshot.requireOperatorApproval ? 'WAITING_APPROVAL' : 'PLANNED';
    const result = await this.pool.query(`INSERT INTO artifact_gc_plans
      (id,tenant_id,mode,status,policy_snapshot,scan_limit,max_delete_bytes,created_by,report)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb) RETURNING *`,
      [randomUUID(), tenantId, mode, status, json(snapshot), snapshot.scanLimit, snapshot.maxDeleteBytes, createdBy, json({ workerId: this.workerId })]);
    return result.rows[0];
  }

  async approvePlan({ tenantId, planId, actor }) {
    if (!actor) throw new TypeError('actor is required');
    const result = await this.pool.query(`UPDATE artifact_gc_plans SET operator_approved=true,approved_by=$1,approved_at=now(),status=CASE WHEN status='WAITING_APPROVAL' THEN 'PLANNED' ELSE status END WHERE id=$2 AND tenant_id=$3 AND mode='ENFORCE' AND status IN ('WAITING_APPROVAL','PLANNED') RETURNING *`, [actor, planId, tenantId]);
    if (!result.rows[0]) throw Object.assign(new Error('GC plan cannot be approved'), { code: 'GC_PLAN_NOT_APPROVABLE' });
    return result.rows[0];
  }

  async cancelPlan({ tenantId, planId }) {
    const result = await this.pool.query(`UPDATE artifact_gc_plans SET cancellation_requested=true,status=CASE WHEN status IN ('PLANNED','WAITING_APPROVAL','RUNNING') THEN 'CANCELLED' ELSE status END,finished_at=CASE WHEN status IN ('PLANNED','WAITING_APPROVAL') THEN now() ELSE finished_at END WHERE id=$1 AND tenant_id=$2 RETURNING *`, [planId, tenantId]);
    return result.rows[0] || null;
  }

  async _reachableArtifactIds(client, tenantId) {
    const ids = new Set();
    const queries = [
      `SELECT a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND (e.current_render_id=a.id OR e.approved_render_id=a.id OR e.current_versions::text LIKE '%'||a.version_id||'%')`,
      `SELECT a.id FROM artifacts a JOIN approvals ap ON ap.target_version_id=a.version_id JOIN episodes e ON e.id=ap.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ap.decision='APPROVED'`,
      `SELECT a.id FROM artifacts a JOIN qa_results q ON (q.artifact_id=a.id OR q.version_id=a.version_id) JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND q.status IN ('PASSED','WARNINGS')`,
      `SELECT a.id FROM artifacts a JOIN publish_runs r ON (r.render_artifact_id=a.id OR r.package_artifact_id=a.id) JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND r.status IN ('QUEUED','UPLOADING','PUBLISHED')`,
      `SELECT a.id FROM artifacts a JOIN forge_jobs j ON (j.payload::text LIKE '%'||a.id||'%' OR j.result::text LIKE '%'||a.id||'%') JOIN projects p ON p.id=j.project_id WHERE p.tenant_id=$1 AND j.status IN ('QUEUED','RUNNING')`,
      `SELECT a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE p.tenant_id=$1 AND l.state IN ('RETAINED','PROTECTED','QUARANTINED','DELETION_PENDING')`,
      `SELECT a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN forge_evidence_nodes n ON n.project_id=p.id WHERE p.tenant_id=$1 AND n.lifecycle_state='ACTIVE' AND (n.payload::text LIKE '%'||a.id||'%' OR n.source_id=a.id)`,
    ];
    for (const sql of queries) {
      try { const result = await client.query(sql, [tenantId]); for (const row of result.rows) ids.add(row.id); }
      catch (error) { if (error.code !== '42P01' && error.code !== '42703') throw error; }
    }
    return ids;
  }

  async _scanPlan(client, plan) {
    const policy = plan.policy_snapshot || this.policy;
    const roots = await this._reachableArtifactIds(client, plan.tenant_id);
    const result = await client.query(`SELECT o.*, COUNT(r.id) FILTER (WHERE r.active)::bigint AS live_refs
      FROM artifact_content_objects o LEFT JOIN artifact_content_refs r ON r.object_id=o.id AND r.active
      WHERE o.tenant_id=$1 AND o.status IN ('READY','QUARANTINED') AND o.id > COALESCE($2,'')
      GROUP BY o.id ORDER BY o.id LIMIT $3`, [plan.tenant_id, plan.checkpoint_object_id, plan.scan_limit]);
    let scanned = 0, protectedCount = 0, ambiguous = 0, reclaimable = 0;
    const items = [];
    for (const object of result.rows) {
      this._checkCancelled(); scanned += 1;
      const refs = await client.query('SELECT artifact_id,ref_kind FROM artifact_content_refs WHERE object_id=$1 AND active', [object.id]);
      const hasReservation = Number(object.reservation_count) > 0 || (await client.query(`SELECT 1 FROM artifact_storage_reservations WHERE object_id=$1 AND state='HELD' AND expires_at>now() LIMIT 1`, [object.id])).rows.length > 0;
      const protectedRef = refs.rows.some((r) => roots.has(r.artifact_id) || ['IMMUTABLE','RECOVERY','PACKAGE','EXPORT','RUNNER_HANDOFF'].includes(r.ref_kind));
      const evidence = Boolean(object.immutable_evidence || object.recovery_required);
      let decision = 'SKIP'; let reason = 'NO_ACTION';
      if (evidence) { decision = 'PROTECT'; reason = 'IMMUTABLE_EVIDENCE_OR_RECOVERY'; protectedCount += 1; }
      else if (hasReservation) { decision = 'PROTECT'; reason = 'ACTIVE_RESERVATION'; protectedCount += 1; }
      else if (protectedRef) { decision = 'PROTECT'; reason = 'REACHABLE_REFERENCE'; protectedCount += 1; }
      else if (Number(object.live_refs) === 0 && Number(object.ref_count) === 0) {
        const ageMinutes = (Date.now() - new Date(object.last_referenced_at || object.created_at).getTime()) / 60000;
        if (!Number.isFinite(ageMinutes) || ageMinutes < Number(policy.minAgeMinutes ?? this.policy.minAgeMinutes)) { decision = 'AMBIGUOUS'; reason = 'INSUFFICIENT_AGE'; ambiguous += 1; }
        else { decision = 'QUARANTINE'; reason = 'UNREACHABLE_AND_UNREFERENCED'; reclaimable += Number(object.size_bytes); }
      } else if (Number(object.live_refs) !== Number(object.ref_count)) { decision = 'AMBIGUOUS'; reason = 'REFCOUNT_MISMATCH'; ambiguous += 1; }
      items.push({ object, decision, reason, refs: Number(object.live_refs), reservationCount: Number(object.reservation_count), sizeBytes: Number(object.size_bytes) });
    }
    return { rows: result.rows, items, scanned, protectedCount, ambiguous, reclaimable };
  }

  async executePlan({ tenantId, planId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const plan = (await client.query('SELECT * FROM artifact_gc_plans WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [planId, tenantId])).rows[0];
      if (!plan) throw Object.assign(new Error('GC plan not found'), { code: 'NOT_FOUND' });
      if (plan.status === 'CANCELLED' || plan.cancellation_requested) throw cancellationError();
      if (plan.mode === 'ENFORCE' && plan.policy_snapshot?.requireOperatorApproval && !plan.operator_approved) throw Object.assign(new Error('destructive GC requires operator approval'), { code: 'APPROVAL_REQUIRED' });
      await client.query("UPDATE artifact_gc_plans SET status='RUNNING',started_at=COALESCE(started_at,now()) WHERE id=$1", [planId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw error; }
    client.release();
    const scanClient = await this.pool.connect();
    try {
      const current = (await scanClient.query('SELECT * FROM artifact_gc_plans WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [planId, tenantId])).rows[0];
      const scan = await this._scanPlan(scanClient, current);
      for (const item of scan.items) await scanClient.query(`INSERT INTO artifact_gc_items(id,plan_id,tenant_id,object_id,decision,reason,ref_count,reservation_count,size_bytes,diagnostics) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(plan_id,object_id) DO UPDATE SET decision=EXCLUDED.decision,reason=EXCLUDED.reason,ref_count=EXCLUDED.ref_count,reservation_count=EXCLUDED.reservation_count,size_bytes=EXCLUDED.size_bytes,diagnostics=EXCLUDED.diagnostics`, [randomUUID(), planId, tenantId, item.object.id, item.decision, item.reason, item.refs, item.reservationCount, item.sizeBytes, json({ sha256: item.object.sha256, storageKey: item.object.storage_key })]);
      const report = { schemaVersion: 1, planId, tenantId, mode: current.mode, scanned: scan.scanned, protected: scan.protectedCount, ambiguous: scan.ambiguous, reclaimableBytes: scan.reclaimable, checkpoint: scan.rows.at(-1)?.id || current.checkpoint_object_id || null, generatedBy: this.workerId };
      await scanClient.query(`UPDATE artifact_gc_plans SET checkpoint_object_id=$1,scanned_count=scanned_count+$2,protected_count=protected_count+$3,ambiguous_count=ambiguous_count+$4,bytes_reclaimable=bytes_reclaimable+$5,report_hash=$6,report=$7::jsonb,status=CASE WHEN $8 THEN 'COMPLETED' ELSE status END,finished_at=CASE WHEN $8 THEN now() ELSE finished_at END WHERE id=$9`, [report.checkpoint, scan.scanned, scan.protectedCount, scan.ambiguous, scan.reclaimable, digest(report), json(report), scan.rows.length < Number(current.scan_limit), planId]);
      return (await scanClient.query('SELECT * FROM artifact_gc_plans WHERE id=$1', [planId])).rows[0];
    } catch (error) {
      await scanClient.query(`UPDATE artifact_gc_plans SET status='FAILED',report=report||$1::jsonb,finished_at=now() WHERE id=$2`, [json({ error: { code: error.code || 'GC_FAILED', message: error.message } }), planId]).catch(() => {}); throw error;
    } finally { scanClient.release(); }
  }

  async compactApprovedPlan({ tenantId, planId, maxDeletes = 25 }) {
    const planResult = await this.pool.query('SELECT * FROM artifact_gc_plans WHERE id=$1 AND tenant_id=$2', [planId, tenantId]);
    const plan = planResult.rows[0];
    if (!plan || plan.mode !== 'ENFORCE' || !plan.operator_approved) throw Object.assign(new Error('approved ENFORCE plan required'), { code: 'APPROVAL_REQUIRED' });
    const limit = Math.max(1, Math.min(Number(maxDeletes), 100));
    const items = (await this.pool.query(`SELECT i.*,o.storage_key,o.sha256,o.size_bytes FROM artifact_gc_items i JOIN artifact_content_objects o ON o.id=i.object_id WHERE i.plan_id=$1 AND i.decision='QUARANTINE' AND o.status='READY' AND o.ref_count=0 AND o.reservation_count=0 ORDER BY o.id LIMIT $2`, [planId, limit])).rows;
    let deleted = 0, deletedBytes = 0;
    for (const item of items) {
      this._checkCancelled();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const object = (await client.query('SELECT * FROM artifact_content_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [item.object_id, tenantId])).rows[0];
        if (!object || object.status !== 'READY' || Number(object.ref_count) !== 0 || Number(object.reservation_count) !== 0) { await client.query('ROLLBACK'); continue; }
        if ((await client.query('SELECT 1 FROM artifact_content_refs WHERE object_id=$1 AND active LIMIT 1', [item.object_id])).rows.length) { await client.query('ROLLBACK'); continue; }
        const tombstone = (await client.query(`INSERT INTO artifact_storage_tombstones(id,tenant_id,object_id,sha256,storage_key,state,plan_id,reason) VALUES($1,$2,$3,$4,$5,'PENDING',$6,'APPROVED_COMPACTION') RETURNING id`, [randomUUID(),tenantId,object.id,object.sha256,object.storage_key,planId])).rows[0];
        await client.query("UPDATE artifact_content_objects SET status='TOMBSTONED',tombstoned_at=now() WHERE id=$1", [object.id]);
        await client.query('COMMIT');
        try { await this.storage.delete(object.storage_key); }
        catch (error) { const recovery = await this.pool.connect(); try { await recovery.query("UPDATE artifact_content_objects SET status='QUARANTINED',tombstoned_at=NULL WHERE id=$1", [object.id]); await recovery.query("UPDATE artifact_storage_tombstones SET state='CANCELLED' WHERE id=$1", [tombstone.id]); } finally { recovery.release(); } continue; }
        const finish = await this.pool.connect();
        try { await finish.query('BEGIN'); await finish.query("UPDATE artifact_content_objects SET status='DELETED',deleted_at=now() WHERE id=$1 AND status='TOMBSTONED'", [object.id]); await finish.query("UPDATE artifact_storage_tombstones SET state='DELETED',deleted_at=now() WHERE id=$1 AND state='PENDING'", [tombstone.id]); await finish.query("UPDATE artifact_gc_items SET decision='DELETE',reason='PHYSICAL_OBJECT_DELETED' WHERE plan_id=$1 AND object_id=$2", [planId,object.id]); await finish.query('UPDATE artifact_gc_plans SET deleted_count=deleted_count+1,bytes_deleted=bytes_deleted+$1 WHERE id=$2', [object.size_bytes,planId]); await finish.query('COMMIT'); deleted += 1; deletedBytes += Number(object.size_bytes); } catch (error) { await finish.query('ROLLBACK').catch(()=>{}); } finally { finish.release(); }
      } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
    }
    return { planId, deleted, deletedBytes };
  }

  async report({ tenantId, planId }) {
    const plan = (await this.pool.query('SELECT * FROM artifact_gc_plans WHERE id=$1 AND tenant_id=$2', [planId, tenantId])).rows[0];
    if (!plan) throw Object.assign(new Error('GC plan not found'), { code: 'NOT_FOUND' });
    const items = await this.pool.query('SELECT decision,count(*)::int count,coalesce(sum(size_bytes),0)::bigint bytes FROM artifact_gc_items WHERE plan_id=$1 GROUP BY decision ORDER BY decision', [planId]);
    return { plan, items: items.rows };
  }
}

module.exports = { ArtifactRetentionOptimizer, DEFAULT_POLICY, digest };
