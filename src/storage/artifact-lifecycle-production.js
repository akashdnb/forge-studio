'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { ArtifactLifecycleControlPlane, DEFAULT_POLICY } = require('./artifact-lifecycle-control-plane');

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class ProductionArtifactLifecycleControlPlane extends ArtifactLifecycleControlPlane {
  async recoverStaleLeases({ tenantId = null, limit = 500 } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const params = tenantId ? [tenantId, Math.max(1, Number(limit))] : [Math.max(1, Number(limit))];
      const scope = tenantId ? 'AND tenant_id=$1' : '';
      const limitParam = tenantId ? '$2' : '$1';
      const rows = (await client.query(`WITH expired AS (
        SELECT id FROM artifact_use_leases WHERE state='ACTIVE' AND expires_at<=now() ${scope}
        ORDER BY expires_at ASC LIMIT ${limitParam} FOR UPDATE SKIP LOCKED
      ) UPDATE artifact_use_leases l SET state='EXPIRED',released_at=now(),lease_version=lease_version+1
        FROM expired WHERE l.id=expired.id RETURNING l.id,l.tenant_id,l.object_id`, params)).rows;
      await client.query('COMMIT');
      return { recovered: rows.length, leases: rows };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async _reachableObjectIds(client, tenantId) {
    const roots = new Map();
    const add = (objectId, reason, rootType) => { if (objectId) roots.set(objectId, { reason, rootType }); };
    const refRows = await client.query(`SELECT DISTINCT r.object_id,r.ref_kind FROM artifact_content_refs r
      WHERE r.tenant_id=$1 AND r.active=true`, [tenantId]);
    for (const r of refRows.rows) if (['IMMUTABLE','RECOVERY','PACKAGE','EXPORT','RUNNER_HANDOFF'].includes(r.ref_kind)) add(r.object_id, r.ref_kind, 'CONTENT_REF');

    const versions = await client.query(`WITH RECURSIVE roots AS (
      SELECT e.id episode_id, v.version_id
      FROM episodes e JOIN projects p ON p.id=e.project_id
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(e.current_versions,'{}'::jsonb)) v
      WHERE p.tenant_id=$1
      UNION
      SELECT e.id,e.current_render_id FROM episodes e JOIN projects p ON p.id=e.project_id
      WHERE p.tenant_id=$1 AND e.current_render_id IS NOT NULL
    ), closure(version_id) AS (
      SELECT version_id FROM roots
      UNION
      SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN closure c ON c.version_id=vd.version_id
      JOIN episodes ep ON ep.id=vd.episode_id JOIN projects pp ON pp.id=ep.project_id WHERE pp.tenant_id=$1
    ) SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id
      WHERE r.tenant_id=$1 AND r.active=true AND a.version_id IN (SELECT version_id FROM closure)`, [tenantId]);
    for (const row of versions.rows) add(row.object_id, 'VERSION_REACHABLE', 'VERSION_GRAPH');

    const direct = [
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN qa_results q ON q.artifact_id=a.id OR q.version_id=a.version_id JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND r.active AND q.status IN ('PASSED','WARNINGS')`, 'QA', 'QA'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN publish_runs pr ON pr.render_artifact_id=a.id OR pr.package_artifact_id=a.id JOIN episodes e ON e.id=pr.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND r.active AND pr.status IN ('QUEUED','UPLOADING','PUBLISHED')`, 'PUBLISH_RECEIPT', 'PUBLISH'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifacts a ON a.id=r.artifact_id JOIN forge_jobs j ON j.payload::text LIKE '%'||a.id||'%' OR j.result::text LIKE '%'||a.id||'%' JOIN projects p ON p.id=j.project_id WHERE p.tenant_id=$1 AND r.active AND j.status IN ('QUEUED','RUNNING')`, 'ACTIVE_JOB', 'JOB'],
      [`SELECT DISTINCT object_id FROM artifact_use_leases WHERE tenant_id=$1 AND state='ACTIVE' AND expires_at>now() AND object_id IS NOT NULL`, 'ACTIVE_LEASE', 'LEASE'],
      [`SELECT DISTINCT r.object_id FROM artifact_content_refs r JOIN artifact_holds h ON h.artifact_id=r.artifact_id WHERE r.tenant_id=$1 AND r.active AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>now())`, 'LEGAL_HOLD', 'HOLD'],
      [`SELECT DISTINCT o.id FROM artifact_content_objects o WHERE o.tenant_id=$1 AND (o.immutable_evidence OR o.recovery_required)`, 'IMMUTABLE_EVIDENCE', 'CONTENT_POLICY'],
    ];
    for (const [sql, reason, rootType] of direct) {
      try { const result = await client.query(sql, [tenantId]); for (const row of result.rows) add(row.object_id || row.id, reason, rootType); }
      catch (error) { if (!['42P01','42703'].includes(error.code)) throw error; }
    }
    // Recovery/checkpoint tables vary across deployed epochs. If present, they are hard roots.
    for (const table of ['recovery_artifacts','recovery_checkpoints','recovery_points']) {
      try {
        const result = await client.query(`SELECT DISTINCT r.object_id FROM artifact_content_refs r WHERE r.tenant_id=$1 AND r.active=true AND EXISTS (SELECT 1 FROM ${table} x WHERE x.id::text=r.artifact_id OR x.id::text=r.object_id::text)`, [tenantId]);
        for (const row of result.rows) add(row.object_id, 'RECOVERY_CHECKPOINT', 'RECOVERY');
      } catch (error) { if (!['42P01','42703'].includes(error.code)) throw error; }
    }
    return roots;
  }

  async _isProtected(client, tenantId, objectId) {
    const base = await super._isProtected(client, tenantId, objectId);
    if (base.protected) return base;
    const lifecycle = await client.query(`SELECT 1 FROM artifact_lifecycle_records l WHERE l.artifact_id IN
      (SELECT artifact_id FROM artifact_content_refs WHERE object_id=$2 AND tenant_id=$1 AND active=true)
      AND l.state IN ('RETAINED','PROTECTED','DELETION_PENDING') LIMIT 1`, [tenantId, objectId]).catch(() => ({ rows: [] }));
    if (lifecycle.rows[0]) return { protected: true, reason: 'LIFECYCLE_RECORD' };
    return base;
  }

  async sweepGeneration({ tenantId, generationId, actor = this.workerId, dryRun = false } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const generation = (await client.query("SELECT * FROM artifact_gc_generations WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [generationId, tenantId])).rows[0];
      if (!generation || generation.state !== 'MARKED') throw Object.assign(new Error('GC generation is not ready to sweep'), { code: 'GC_STATE_INVALID' });
      const policy = generation.policy_snapshot || DEFAULT_POLICY;
      const candidates = (await client.query(`SELECT o.*,COALESCE(active_ref.project_id,any_ref.project_id) project_id
        FROM artifact_content_objects o
        LEFT JOIN LATERAL (SELECT project_id FROM artifact_content_refs WHERE object_id=o.id AND tenant_id=$1 AND active=true ORDER BY created_at LIMIT 1) active_ref ON true
        LEFT JOIN LATERAL (SELECT project_id FROM artifact_content_refs WHERE object_id=o.id AND tenant_id=$1 ORDER BY created_at DESC LIMIT 1) any_ref ON true
        WHERE o.tenant_id=$1 AND o.status IN ('READY','QUARANTINED')
          AND NOT EXISTS (SELECT 1 FROM artifact_gc_marks m WHERE m.generation_id=$2 AND m.object_id=o.id)
        ORDER BY o.id LIMIT $3`, [tenantId, generationId, Number(policy.scanLimit || this.policy.scanLimit)])).rows;
      let quarantined = 0, ambiguous = 0, bytes = 0;
      for (const object of candidates) {
        this._cancelled();
        if (!object.project_id) { ambiguous++; continue; }
        const protectedNow = await this._isProtected(client, tenantId, object.id);
        const ageDays = (Date.now() - new Date(object.last_referenced_at || object.created_at).getTime()) / 86400000;
        const retentionDays = this._retentionDays(object.kind, object.metadata || {});
        if (protectedNow.protected || !Number.isFinite(ageDays) || ageDays < retentionDays) { ambiguous++; continue; }
        const graceUntil = new Date(Date.now() + Number(policy.quarantineGraceMinutes ?? this.policy.quarantineGraceMinutes) * 60000);
        if (!dryRun) {
          await client.query("UPDATE artifact_content_objects SET status='QUARANTINED' WHERE id=$1 AND tenant_id=$2 AND status='READY'", [object.id, tenantId]);
          await client.query(`INSERT INTO artifact_deletion_intents(id,tenant_id,project_id,object_id,generation_id,state,fence_token,storage_key,sha256,size_bytes,grace_until,approval_required)
            VALUES($1,$2,$3,$4,$5,'QUARANTINED',$6,$7,$8,$9,$10,$11) ON CONFLICT (generation_id,object_id) DO NOTHING`,
            [randomUUID(), tenantId, object.project_id, object.id, generationId, generation.fence_token, object.storage_key, object.sha256, object.size_bytes, graceUntil, Boolean(policy.requireOperatorApproval)]);
          quarantined++; bytes += Number(object.size_bytes);
        }
      }
      await client.query("UPDATE artifact_gc_generations SET state='SWEEPING',ambiguous_count=ambiguous_count+$2,swept_count=swept_count+$3 WHERE id=$1 AND fence_token=$4", [generationId, ambiguous, quarantined, generation.fence_token]);
      await this._evidence(client, { tenantId, generationId, actor, fenceToken: generation.fence_token, action: dryRun ? 'SWEEP_PREVIEW' : 'SWEEP_QUARANTINE', payload: { quarantined, ambiguous, bytes, dryRun } });
      await client.query('COMMIT');
      return { generationId, quarantined, ambiguous, bytes, state: 'SWEEPING', dryRun };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async executeApprovedDeletes({ tenantId, generationId, actor = this.workerId, maxDeletes = 25, maxDeleteBytes = this.policy.maxDeleteBytes } = {}) {
    const rows = (await this.pool.query(`SELECT d.*,o.status object_status FROM artifact_deletion_intents d JOIN artifact_content_objects o ON o.id=d.object_id
      WHERE d.tenant_id=$1 AND d.generation_id=$2 AND d.state='APPROVED' AND d.grace_until<=now() ORDER BY d.id LIMIT $3`, [tenantId, generationId, Math.max(1, Number(maxDeletes))])).rows;
    let deleted = 0, failed = 0, protectedCount = 0, bytesDeleted = 0;
    for (const intent of rows) {
      this._cancelled();
      if (bytesDeleted + Number(intent.size_bytes) > Number(maxDeleteBytes)) break;
      const lock = await this.pool.connect();
      try {
        await lock.query('BEGIN');
        const current = (await lock.query(`SELECT d.*,o.status,o.storage_key,o.sha256,o.size_bytes FROM artifact_deletion_intents d JOIN artifact_content_objects o ON o.id=d.object_id
          WHERE d.id=$1 AND d.tenant_id=$2 FOR UPDATE OF d,o`, [intent.id, tenantId])).rows[0];
        if (!current || current.state !== 'APPROVED') { await lock.query('ROLLBACK'); continue; }
        const protection = await this._isProtected(lock, tenantId, current.object_id);
        if (protection.protected) {
          await lock.query("UPDATE artifact_deletion_intents SET state='CANCELLED',cancelled_at=now(),last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2", [current.id, tenantId, JSON.stringify({ code: 'LATE_REFERENCE', reason: protection.reason })]);
          await lock.query("UPDATE artifact_content_objects SET status='READY' WHERE id=$1 AND tenant_id=$2 AND status='QUARANTINED'", [current.object_id, tenantId]);
          await lock.query('COMMIT'); protectedCount++; continue;
        }
        const head = typeof this.storage.head === 'function' ? await this.storage.head(current.storage_key) : null;
        if (head && ((head.sha256 && head.sha256 !== current.sha256) || Number(head.sizeBytes) !== Number(current.size_bytes))) {
          throw Object.assign(new Error('storage checksum/size mismatch; deletion refused'), { code: 'STORAGE_INTEGRITY_MISMATCH', retryable: false });
        }
        await lock.query("UPDATE artifact_deletion_intents SET state='DELETING',deleting_at=now(),provider_attempts=provider_attempts+1 WHERE id=$1 AND tenant_id=$2 AND state='APPROVED'", [current.id, tenantId]);
        await lock.query('COMMIT');
      } catch (error) { await lock.query('ROLLBACK').catch(() => {}); lock.release(); failed++; await this._providerFailure(intent, error); continue; }
      lock.release();
      try {
        await this.storage.delete(intent.storage_key);
        const present = typeof this.storage.head === 'function' ? await this.storage.head(intent.storage_key) : null;
        if (present) throw Object.assign(new Error('provider delete not reconciled'), { code: 'PROVIDER_DELETE_NOT_CONFIRMED', retryable: true });
        const finalized = await this._finalizeDelete(tenantId, intent.id, actor);
        if (finalized) { deleted++; bytesDeleted += Number(intent.size_bytes); }
      } catch (error) { failed++; await this._providerFailure(intent, error); }
    }
    return { generationId, attempted: rows.length, deleted, failed, protected: protectedCount, bytesDeleted };
  }

  async _providerFailure(intent, error) {
    await this.pool.query(`UPDATE artifact_deletion_intents SET state='QUARANTINED',last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2 AND state IN ('APPROVED','DELETING')`, [intent.id, intent.tenant_id, JSON.stringify({ code: error.code || 'STORAGE_DELETE_FAILED', message: error.message })]);
    await this._recordReconciliation(intent.tenant_id, intent.object_id, intent.storage_key, error);
  }
}

module.exports = { ProductionArtifactLifecycleControlPlane };
