'use strict';
const { randomUUID, createHash } = require('node:crypto');

const DEFAULT_POLICY = Object.freeze({
  quarantineGraceMinutes: 1440,
  defaultRetentionDays: 30,
  retentionDays: { render: 90, package: 365, audio: 90, image: 90, video: 90, caption: 90, 'render-manifest': 90, default: 30 },
  scanLimit: 250,
  maxDeleteBytes: 1073741824,
  leaseMinutes: 30,
  requireOperatorApproval: true,
});

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function nowPlusMinutes(minutes) { return new Date(Date.now() + Math.max(0, Number(minutes)) * 60000); }
function bool(value) { return value === true || value === 'true'; }

class ArtifactLifecycleControlPlane {
  constructor({ pool, storage, workerId = `artifact-gc:${randomUUID()}`, policy = {}, metrics = null, logger = console, signal } = {}) {
    if (!pool?.connect || !pool?.query) throw new TypeError('pg-compatible pool is required');
    if (!storage || typeof storage.delete !== 'function') throw new TypeError('storage backend with delete() is required');
    this.pool = pool; this.storage = storage; this.workerId = workerId; this.metrics = metrics; this.logger = logger; this.signal = signal;
    this.policy = { ...DEFAULT_POLICY, ...policy, retentionDays: { ...DEFAULT_POLICY.retentionDays, ...(policy.retentionDays || {}) } };
  }
  _cancelled() { if (this.signal?.aborted) throw Object.assign(new Error('artifact GC cancelled'), { code: 'CANCELLED' }); }
  _retentionDays(kind, metadata = {}) { const cls = metadata.retentionClass || kind || 'default'; return Number(this.policy.retentionDays[cls] ?? this.policy.retentionDays.default ?? this.policy.defaultRetentionDays); }
  async _tenantScope(client, tenantId, projectId = null) {
    const tenant = await client.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE', [tenantId]);
    if (!tenant.rows[0]) throw Object.assign(new Error('tenant not found'), { code: 'TENANT_NOT_FOUND' });
    if (projectId) {
      const project = await client.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR SHARE', [projectId, tenantId]);
      if (!project.rows[0]) throw Object.assign(new Error('tenant/project mismatch'), { code: 'TENANT_SCOPE_VIOLATION' });
    }
  }
  async acquireUseLease({ tenantId, projectId, artifactId, ownerId, purpose, ttlMinutes = this.policy.leaseMinutes, metadata = {} }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this._tenantScope(client, tenantId, projectId);
      const artifact = (await client.query(`SELECT a.id,a.episode_id,e.project_id,p.tenant_id,s.artifact_id AS stored_artifact_id,s.id AS object_storage_id
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
        LEFT JOIN storage_objects s ON s.artifact_id=a.id
        WHERE a.id=$1 AND p.tenant_id=$2 FOR SHARE`, [artifactId, tenantId])).rows[0];
      if (!artifact) throw Object.assign(new Error('artifact not found in tenant'), { code: 'TENANT_SCOPE_VIOLATION' });
      const content = (await client.query('SELECT object_id FROM artifact_content_refs WHERE artifact_id=$1 AND tenant_id=$2 AND active=true', [artifactId, tenantId])).rows[0];
      const objectId = content?.object_id || null;
      if (objectId) await client.query('SELECT id FROM artifact_content_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [objectId, tenantId]);
      const id = randomUUID();
      const row = (await client.query(`INSERT INTO artifact_use_leases(id,tenant_id,project_id,artifact_id,object_id,purpose,owner_id,state,expires_at,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',now()+($8::text||' minutes')::interval,$9::jsonb) RETURNING *`,
        [id, tenantId, projectId || artifact.project_id, artifactId, objectId, purpose || 'workflow', ownerId || this.workerId, Math.max(1, Number(ttlMinutes)), JSON.stringify(metadata)])).rows[0];
      await this._evidence(client, { tenantId, projectId: projectId || artifact.project_id, objectId, action: 'LEASE_ACQUIRED', actor: ownerId || this.workerId, payload: { leaseId: id, artifactId, purpose } });
      await client.query('COMMIT');
      return row;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async heartbeatLease({ tenantId, leaseId, ownerId, ttlMinutes = this.policy.leaseMinutes }) {
    const result = await this.pool.query(`UPDATE artifact_use_leases SET heartbeat_at=now(),expires_at=now()+($4::text||' minutes')::interval,lease_version=lease_version+1
      WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND state='ACTIVE' AND expires_at>now() RETURNING *`, [leaseId, tenantId, ownerId, Math.max(1, Number(ttlMinutes))]);
    if (!result.rows[0]) throw Object.assign(new Error('active artifact lease not found'), { code: 'LEASE_NOT_FOUND' });
    return result.rows[0];
  }
  async releaseLease({ tenantId, leaseId, ownerId }) {
    const result = await this.pool.query(`UPDATE artifact_use_leases SET state='RELEASED',released_at=now(),lease_version=lease_version+1 WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND state='ACTIVE' RETURNING *`, [leaseId, tenantId, ownerId]);
    return result.rows[0] || null;
  }
  async recoverStaleLeases({ tenantId = null, limit = 500 } = {}) {
    const params = tenantId ? [tenantId, Math.max(1, Number(limit))] : [Math.max(1, Number(limit))];
    const sql = tenantId
      ? `UPDATE artifact_use_leases SET state='EXPIRED',released_at=now(),lease_version=lease_version+1 WHERE tenant_id=$1 AND state='ACTIVE' AND expires_at<=now() RETURNING id,tenant_id,object_id`
      : `UPDATE artifact_use_leases SET state='EXPIRED',released_at=now(),lease_version=lease_version+1 WHERE state='ACTIVE' AND expires_at<=now() RETURNING id,tenant_id,object_id`;
    const result = await this.pool.query(`${sql} LIMIT ${Math.max(1, Number(limit))}`, params);
    return { recovered: result.rowCount || 0, leases: result.rows };
  }
  async createGeneration({ tenantId, actor = 'system', mode = 'DRY_RUN', policy = {} } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this._tenantScope(client, tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('forge-artifact-gc:'||$1))", [tenantId]);
      const active = await client.query("SELECT id FROM artifact_gc_generations WHERE tenant_id=$1 AND state IN ('MARKING','MARKED','SWEEPING') FOR UPDATE", [tenantId]);
      if (active.rows[0]) throw Object.assign(new Error('another artifact GC generation is active'), { code: 'GC_BUSY', generationId: active.rows[0].id });
      const next = Number((await client.query('SELECT COALESCE(MAX(generation),0)+1 AS generation FROM artifact_gc_generations WHERE tenant_id=$1', [tenantId])).rows[0].generation);
      const id = randomUUID();
      const snapshot = { ...this.policy, ...policy, retentionDays: { ...this.policy.retentionDays, ...(policy.retentionDays || {}) }, mode, actor, schemaVersion: 2 };
      const row = (await client.query(`INSERT INTO artifact_gc_generations(id,tenant_id,generation,state,policy_snapshot,worker_id,fence_token)
        VALUES($1,$2,$3,'MARKING',$4::jsonb,$5,$6) RETURNING *`, [id, tenantId, next, JSON.stringify(snapshot), this.workerId, randomUUID()])).rows[0];
      await this._evidence(client, { tenantId, generationId: id, action: 'GENERATION_CREATED', actor, fenceToken: row.fence_token, payload: { generation: next, mode, policy: snapshot } });
      await client.query('COMMIT');
      return row;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async _reachableObjectIds(client, tenantId) {
    const roots = new Map();
    const add = (objectId, reason, rootType) => { if (objectId) roots.set(objectId, { reason, rootType }); };
    const refRows = await client.query(`SELECT DISTINCT r.object_id,r.ref_kind
      FROM artifact_content_refs r JOIN projects p ON p.id=r.project_id
      WHERE r.tenant_id=$1 AND r.active=true`, [tenantId]);
    for (const r of refRows.rows) if (['IMMUTABLE','RECOVERY','PACKAGE','EXPORT','RUNNER_HANDOFF'].includes(r.ref_kind)) add(r.object_id, r.ref_kind, 'CONTENT_REF');

    const versionRoots = await client.query(`WITH RECURSIVE roots AS (
      SELECT e.id episode_id, jsonb_array_elements_text(COALESCE(e.current_versions,'{}'::jsonb)::jsonb) version_id
      FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1
      UNION ALL SELECT e.id,e.current_render_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND e.current_render_id IS NOT NULL
    ), closure AS (
      SELECT version_id FROM roots WHERE version_id IS NOT NULL
      UNION
      SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN closure c ON c.version_id=vd.version_id
      WHERE vd.episode_id IN (SELECT id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1)
    ) SELECT DISTINCT a.id FROM artifacts a WHERE a.version_id IN (SELECT version_id FROM closure)`, [tenantId]).catch(() => ({ rows: [] }));
    for (const r of versionRoots.rows) {
      const ref = (await client.query('SELECT object_id FROM artifact_content_refs WHERE artifact_id=$1 AND active=true', [r.id])).rows[0];
      if (ref) add(ref.object_id, 'VERSION_REACHABLE', 'VERSION_GRAPH');
    }

    const direct = [
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN qa_results q ON q.artifact_id=a.id OR q.version_id=a.version_id JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND r.active AND q.status IN ('PASSED','WARNINGS')`, 'QA', 'QA'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN publish_runs pr ON pr.render_artifact_id=a.id OR pr.package_artifact_id=a.id JOIN episodes e ON e.id=pr.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND r.active AND pr.status IN ('QUEUED','UPLOADING','PUBLISHED')`, 'PUBLISH', 'PUBLISH_RECEIPT'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN forge_jobs j ON j.payload::text LIKE '%'||a.id||'%' OR j.result::text LIKE '%'||a.id||'%' JOIN projects p ON p.id=j.project_id WHERE p.tenant_id=$1 AND r.active AND j.status IN ('QUEUED','RUNNING')`, 'ACTIVE_JOB', 'JOB'],
      [`SELECT DISTINCT l.object_id FROM artifact_use_leases l WHERE l.tenant_id=$1 AND l.state='ACTIVE' AND l.expires_at>now() AND l.object_id IS NOT NULL`, 'ACTIVE_LEASE', 'LEASE'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifact_holds h ON h.artifact_id=r.artifact_id WHERE r.tenant_id=$1 AND r.active AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now())`, 'LEGAL_OR_RECOVERY_HOLD', 'HOLD'],
      [`SELECT DISTINCT o.id FROM artifact_content_objects o WHERE o.tenant_id=$1 AND (o.immutable_evidence OR o.recovery_required)`, 'IMMUTABLE_EVIDENCE', 'CONTENT_POLICY'],
    ];
    for (const [sql, reason, rootType] of direct) {
      try { const result = await client.query(sql, [tenantId]); for (const r of result.rows) add(r.object_id || r.id, reason, rootType); }
      catch (error) { if (!['42P01','42703'].includes(error.code)) throw error; }
    }
    return roots;
  }
  async markGeneration({ tenantId, generationId, actor = this.workerId, scanLimit = this.policy.scanLimit } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const generation = (await client.query("SELECT * FROM artifact_gc_generations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [generationId, tenantId])).rows[0];
      if (!generation) throw Object.assign(new Error('GC generation not found'), { code: 'NOT_FOUND' });
      if (!['MARKING','MARKED'].includes(generation.state)) throw Object.assign(new Error(`generation is ${generation.state}`), { code: 'GC_STATE_INVALID' });
      const roots = await this._reachableObjectIds(client, tenantId);
      let marked = 0;
      for (const [objectId, root] of roots) {
        const evidence = hash({ generationId, objectId, root });
        await client.query(`INSERT INTO artifact_gc_marks(generation_id,object_id,reason,root_type,evidence_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [generationId, objectId, root.reason, root.rootType, evidence]);
        marked++;
      }
      await client.query(`UPDATE artifact_gc_generations SET state='MARKED',marked_count=$2,protected_count=$2 WHERE id=$1 AND fence_token=$3`, [generationId, marked, generation.fence_token]);
      await this._evidence(client, { tenantId, generationId, actor, fenceToken: generation.fence_token, action: 'MARK_COMPLETE', payload: { marked, scanLimit } });
      await client.query('COMMIT');
      this.metrics?.inc?.('forge_artifact_gc_generations_total', { phase: 'mark', outcome: 'success' });
      return { generationId, marked, state: 'MARKED' };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); this.metrics?.inc?.('forge_artifact_gc_generations_total', { phase: 'mark', outcome: 'error' }); throw error; } finally { client.release(); }
  }
  async sweepGeneration({ tenantId, generationId, actor = this.workerId, dryRun = false, approve = false, maxDeleteBytes = this.policy.maxDeleteBytes } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const generation = (await client.query("SELECT * FROM artifact_gc_generations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [generationId, tenantId])).rows[0];
      if (!generation || generation.state !== 'MARKED') throw Object.assign(new Error('GC generation is not ready to sweep'), { code: 'GC_STATE_INVALID' });
      const policy = generation.policy_snapshot || this.policy;
      const candidates = (await client.query(`SELECT o.*,p.id project_id
        FROM artifact_content_objects o
        JOIN artifact_content_refs r ON r.object_id=o.id AND r.active=true
        JOIN projects p ON p.tenant_id=o.tenant_id AND p.id=r.project_id
        WHERE o.tenant_id=$1 AND o.status IN ('READY','QUARANTINED')
          AND NOT EXISTS (SELECT 1 FROM artifact_gc_marks m WHERE m.generation_id=$2 AND m.object_id=o.id)
        GROUP BY o.id,p.id ORDER BY o.id LIMIT $3`, [tenantId, generationId, Number(policy.scanLimit || this.policy.scanLimit)])).rows;
      let quarantined = 0, ambiguous = 0, bytes = 0;
      for (const object of candidates) {
        this._cancelled();
        const ageDays = (Date.now() - new Date(object.last_referenced_at || object.created_at).getTime()) / 86400000;
        const retentionDays = this._retentionDays(object.kind, object.metadata || {});
        const protectedNow = await this._isProtected(client, tenantId, object.id);
        if (protectedNow.protected) { ambiguous++; continue; }
        if (!Number.isFinite(ageDays) || ageDays < retentionDays) { ambiguous++; continue; }
        const graceUntil = nowPlusMinutes(Number(policy.quarantineGraceMinutes ?? this.policy.quarantineGraceMinutes));
        if (!dryRun) {
          await client.query("UPDATE artifact_content_objects SET status='QUARANTINED' WHERE id=$1 AND tenant_id=$2 AND status='READY'", [object.id, tenantId]);
          const existing = (await client.query("SELECT id FROM artifact_deletion_intents WHERE generation_id=$1 AND object_id=$2 FOR UPDATE", [generationId, object.id])).rows[0];
          if (!existing) await client.query(`INSERT INTO artifact_deletion_intents(id,tenant_id,project_id,object_id,generation_id,state,fence_token,storage_key,sha256,size_bytes,grace_until,approval_required)
            VALUES($1,$2,$3,$4,$5,'QUARANTINED',$6,$7,$8,$9,$10,$11)`, [randomUUID(), tenantId, object.project_id, object.id, generationId, generation.fence_token, object.storage_key, object.sha256, object.size_bytes, graceUntil, bool(policy.requireOperatorApproval)]);
          quarantined++; bytes += Number(object.size_bytes);
        }
      }
      await client.query("UPDATE artifact_gc_generations SET state='SWEEPING',ambiguous_count=ambiguous_count+$2,swept_count=swept_count+$3 WHERE id=$1 AND fence_token=$4", [generationId, ambiguous, quarantined, generation.fence_token]);
      await this._evidence(client, { tenantId, generationId, actor, fenceToken: generation.fence_token, action: dryRun ? 'SWEEP_PREVIEW' : 'SWEEP_QUARANTINE', payload: { quarantined, ambiguous, bytes, dryRun } });
      await client.query('COMMIT');
      return { generationId, quarantined, ambiguous, bytes, state: 'SWEEPING', dryRun };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async approveGeneration({ tenantId, generationId, actor }) {
    if (!actor) throw new TypeError('actor is required');
    const result = await this.pool.query(`UPDATE artifact_deletion_intents SET state='APPROVED',approved_by=$3,approved_at=now()
      WHERE tenant_id=$1 AND generation_id=$2 AND state='QUARANTINED' AND grace_until<=now() AND approval_required=true RETURNING id,object_id`, [tenantId, generationId, actor]);
    return { generationId, approved: result.rowCount || 0, actor };
  }
  async _isProtected(client, tenantId, objectId) {
    const lease = await client.query(`SELECT 1 FROM artifact_use_leases WHERE tenant_id=$1 AND object_id=$2 AND state='ACTIVE' AND expires_at>now() LIMIT 1`, [tenantId, objectId]);
    if (lease.rows[0]) return { protected: true, reason: 'ACTIVE_LEASE' };
    const hold = await client.query(`SELECT 1 FROM artifact_content_refs r JOIN artifact_holds h ON h.artifact_id=r.artifact_id WHERE r.tenant_id=$1 AND r.object_id=$2 AND r.active AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now()) LIMIT 1`, [tenantId, objectId]);
    if (hold.rows[0]) return { protected: true, reason: 'HOLD' };
    const ref = await client.query(`SELECT 1 FROM artifact_content_refs r WHERE r.tenant_id=$1 AND r.object_id=$2 AND r.active AND r.ref_kind IN ('IMMUTABLE','RECOVERY','PACKAGE','EXPORT','RUNNER_HANDOFF') LIMIT 1`, [tenantId, objectId]);
    if (ref.rows[0]) return { protected: true, reason: 'IMMUTABLE_REFERENCE' };
    return { protected: false };
  }
  async executeApprovedDeletes({ tenantId, generationId, actor = this.workerId, maxDeletes = 25, maxDeleteBytes = this.policy.maxDeleteBytes } = {}) {
    const client = await this.pool.connect(); let total = 0, bytes = 0, deleted = 0, cancelled = 0, failed = 0;
    try {
      await client.query('BEGIN');
      const generation = (await client.query("SELECT * FROM artifact_gc_generations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [generationId, tenantId])).rows[0];
      if (!generation || !['SWEEPING','MARKED'].includes(generation.state)) throw Object.assign(new Error('GC generation is not executable'), { code: 'GC_STATE_INVALID' });
      const intents = (await client.query(`SELECT d.*,o.status object_status,o.storage_key current_storage_key,o.sha256 current_sha256,o.size_bytes current_size
        FROM artifact_deletion_intents d JOIN artifact_content_objects o ON o.id=d.object_id
        WHERE d.tenant_id=$1 AND d.generation_id=$2 AND d.state='APPROVED' AND d.grace_until<=now()
        ORDER BY d.id LIMIT $3 FOR UPDATE OF d`, [tenantId, generationId, Math.max(1, Number(maxDeletes))])).rows;
      await client.query('COMMIT');
      for (const intent of intents) {
        this._cancelled();
        const reservation = await this.pool.query("SELECT 1 FROM artifact_storage_reservations WHERE object_id=$1 AND state='HELD' AND expires_at>now() LIMIT 1", [intent.object_id]);
        const protectedNow = await this._withObjectLock(tenantId, intent.object_id);
        if (reservation.rows[0] || protectedNow.protected || bytes + Number(intent.size_bytes) > Number(maxDeleteBytes)) {
          await this._cancelIntent(tenantId, intent.id, protectedNow.reason || 'ACTIVE_RESERVATION'); cancelled++; continue;
        }
        await this.pool.query("UPDATE artifact_deletion_intents SET state='DELETING',deleting_at=now(),provider_attempts=provider_attempts+1 WHERE id=$1 AND tenant_id=$2 AND state='APPROVED'", [intent.id, tenantId]);
        try {
          await this.storage.delete(intent.storage_key);
          const verified = await this._providerAbsent(intent.storage_key);
          if (!verified) throw Object.assign(new Error('storage provider still reports object present'), { code: 'PROVIDER_RECONCILIATION_FAILED', retryable: true });
          const finalized = await this._finalizeDelete(tenantId, intent.id, actor);
          if (finalized) { deleted++; bytes += Number(intent.size_bytes); }
        } catch (error) {
          failed++;
          await this.pool.query(`UPDATE artifact_deletion_intents SET state='QUARANTINED',last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2 AND state='DELETING'`, [intent.id, tenantId, JSON.stringify({ code: error.code || 'STORAGE_DELETE_FAILED', message: error.message })]);
          await this._recordReconciliation(tenantId, intent.object_id, intent.storage_key, error);
        }
        total++;
      }
      const remaining = Number((await this.pool.query("SELECT count(*)::int count FROM artifact_deletion_intents WHERE tenant_id=$1 AND generation_id=$2 AND state='APPROVED'", [tenantId, generationId])).rows[0].count || 0);
      if (!remaining) await this.pool.query("UPDATE artifact_gc_generations SET state='COMPLETED',finished_at=now() WHERE id=$1 AND tenant_id=$2 AND state IN ('SWEEPING','MARKED')", [generationId, tenantId]);
      this.metrics?.inc?.('forge_artifact_gc_deletes_total', { outcome: 'complete' }, deleted);
      return { generationId, attempted: total, deleted, cancelled, failed, bytesDeleted: bytes, remaining };
    } finally { try { await client.query('ROLLBACK'); } catch {} client.release(); }
  }
  async _withObjectLock(tenantId, objectId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const object = (await client.query('SELECT id FROM artifact_content_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [objectId, tenantId])).rows[0];
      if (!object) return { protected: true, reason: 'TENANT_SCOPE' };
      const result = await this._isProtected(client, tenantId, objectId);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async _cancelIntent(tenantId, intentId, reason) {
    await this.pool.query("UPDATE artifact_deletion_intents SET state='CANCELLED',cancelled_at=now(),last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2 AND state='APPROVED'", [intentId, tenantId, JSON.stringify({ code: 'PROTECTED', reason })]);
  }
  async _providerAbsent(storageKey) {
    if (typeof this.storage.head !== 'function') return true;
    const head = await this.storage.head(storageKey);
    return !head;
  }
  async _finalizeDelete(tenantId, intentId, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const intent = (await client.query("SELECT * FROM artifact_deletion_intents WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [intentId, tenantId])).rows[0];
      if (!intent || intent.state !== 'DELETING') { await client.query('ROLLBACK'); return false; }
      const protectedNow = await this._isProtected(client, tenantId, intent.object_id);
      if (protectedNow.protected) {
        await client.query("UPDATE artifact_deletion_intents SET state='CANCELLED',cancelled_at=now(),last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2", [intentId, tenantId, JSON.stringify({ code: 'LATE_REFERENCE', reason: protectedNow.reason })]);
        await client.query("UPDATE artifact_content_objects SET status='READY' WHERE id=$1 AND tenant_id=$2 AND status='QUARANTINED'", [intent.object_id, tenantId]);
        await client.query('COMMIT'); return false;
      }
      await client.query("UPDATE artifact_content_objects SET status='DELETED',deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND status='QUARANTINED'", [intent.object_id, tenantId]);
      await client.query("UPDATE artifact_deletion_intents SET state='DELETED',deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND state='DELETING'", [intentId, tenantId]);
      await this._evidence(client, { tenantId, projectId: intent.project_id, objectId: intent.object_id, generationId: intent.generation_id, deletionIntentId: intent.id, action: 'OBJECT_DELETED', actor, fenceToken: intent.fence_token, payload: { storageKey: intent.storage_key, sha256: intent.sha256, sizeBytes: intent.size_bytes } });
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async _recordReconciliation(tenantId, objectId, storageKey, error) {
    const evidence = hash({ tenantId, objectId, storageKey, error: error.code || error.message });
    await this.pool.query(`INSERT INTO artifact_provider_reconciliation(id,tenant_id,object_id,storage_key,observed_state,action,evidence_hash,details)
      VALUES($1,$2,$3,$4,'UNKNOWN','RETRY',$5,$6::jsonb)`, [randomUUID(), tenantId, objectId, storageKey, evidence, JSON.stringify({ code: error.code, message: error.message })]);
  }
  async reconcileProvider({ tenantId, limit = 100 } = {}) {
    const rows = (await this.pool.query(`SELECT o.id,o.storage_key,o.sha256,o.size_bytes,o.status FROM artifact_content_objects o
      WHERE o.tenant_id=$1 AND o.status IN ('READY','QUARANTINED','TOMBSTONED') ORDER BY o.id LIMIT $2`, [tenantId, Math.max(1, Number(limit))])).rows;
    const result = { checked: 0, missing: 0, confirmed: 0, resurrected: 0 };
    for (const object of rows) {
      const head = await this.storage.head(object.storage_key).catch(error => ({ error })); result.checked++;
      if (head?.error) { await this._recordReconciliation(tenantId, object.id, object.storage_key, head.error); continue; }
      const present = Boolean(head);
      if (!present) { result.missing++; await this.pool.query("UPDATE artifact_content_objects SET status=CASE WHEN status='DELETED' THEN status ELSE 'QUARANTINED' END WHERE id=$1 AND tenant_id=$2", [object.id, tenantId]); }
      else { result.confirmed++; if (object.status === 'QUARANTINED') { const protectedNow = await this._withObjectLock(tenantId, object.id); if (protectedNow.protected) { result.resurrected++; await this.pool.query("UPDATE artifact_content_objects SET status='READY' WHERE id=$1 AND tenant_id=$2", [object.id, tenantId]); } } }
      await this.pool.query(`INSERT INTO artifact_provider_reconciliation(id,tenant_id,object_id,storage_key,observed_state,expected_sha256,observed_sha256,expected_size_bytes,observed_size_bytes,action,evidence_hash,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`, [randomUUID(), tenantId, object.id, object.storage_key, present ? 'PRESENT' : 'MISSING', object.sha256, head?.sha256 || null, object.size_bytes, head?.sizeBytes || null, present ? 'CONFIRMED' : 'MISSING', hash({ object, present, head: head ? { sizeBytes: head.sizeBytes, sha256: head.sha256 } : null }), JSON.stringify({ status: object.status })]);
    }
    return result;
  }
  async preview({ tenantId, actor = 'operator', policy = {} } = {}) {
    const generation = await this.createGeneration({ tenantId, actor, mode: 'DRY_RUN', policy });
    const marked = await this.markGeneration({ tenantId, generationId: generation.id, actor });
    const sweep = await this.sweepGeneration({ tenantId, generationId: generation.id, actor, dryRun: true });
    return { generation, marked, sweep, destructive: false };
  }
  async health({ tenantId = null } = {}) {
    const params = tenantId ? [tenantId] : [];
    const where = tenantId ? 'WHERE tenant_id=$1' : '';
    const [generations, intents, leases] = await Promise.all([
      this.pool.query(`SELECT state,count(*)::int count FROM artifact_gc_generations ${where} GROUP BY state`, params),
      this.pool.query(`SELECT state,count(*)::int count FROM artifact_deletion_intents ${where} GROUP BY state`, params),
      this.pool.query(`SELECT state,count(*)::int count FROM artifact_use_leases ${where} GROUP BY state`, params),
    ]);
    return { healthy: true, generations: generations.rows, deletionIntents: intents.rows, leases: leases.rows, workerId: this.workerId };
  }
  async _evidence(client, { tenantId, projectId = null, objectId = null, generationId = null, deletionIntentId = null, action, actor, fenceToken = null, payload = {} }) {
    const evidenceHash = hash({ tenantId, projectId, objectId, generationId, deletionIntentId, action, actor, fenceToken, payload });
    await client.query(`INSERT INTO artifact_lifecycle_evidence(tenant_id,project_id,object_id,generation_id,deletion_intent_id,action,actor,fence_token,evidence_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [tenantId, projectId, objectId, generationId, deletionIntentId, action, actor, fenceToken, evidenceHash, JSON.stringify(payload)]);
    return evidenceHash;
  }
}

module.exports = { ArtifactLifecycleControlPlane, DEFAULT_POLICY };
