'use strict';

const { randomUUID, createHash } = require('node:crypto');

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

async function drain(stream) {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

class ArtifactIntegrityControlPlane {
  constructor({ pool, storage, logger = console, metrics = null, signal } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    if (!storage || typeof storage.download !== 'function') throw new TypeError('storage backend with download() is required');
    this.pool = pool;
    this.storage = storage;
    this.logger = logger;
    this.metrics = metrics;
    this.signal = signal;
  }

  _cancelled() {
    if (this.signal?.aborted) throw Object.assign(new Error('artifact integrity scan cancelled'), { code: 'CANCELLED' });
  }

  async _scope(client, tenantId, projectId = null) {
    const tenant = await client.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE', [tenantId]);
    if (!tenant.rows[0]) throw Object.assign(new Error('tenant not found'), { code: 'TENANT_NOT_FOUND' });
    if (projectId) {
      const project = await client.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR SHARE', [projectId, tenantId]);
      if (!project.rows[0]) throw Object.assign(new Error('tenant/project mismatch'), { code: 'TENANT_SCOPE_VIOLATION' });
    }
  }

  async recordArtifactLineage({ childArtifactId, parentArtifactId, relation = 'DERIVED_FROM', actor = 'worker', evidence = {} }) {
    if (!childArtifactId || !parentArtifactId) throw new TypeError('childArtifactId and parentArtifactId are required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const child = (await client.query(`SELECT a.id,a.version_id,e.episode_id,e.project_id,p.tenant_id
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1 FOR SHARE`, [childArtifactId])).rows[0];
      const parent = (await client.query(`SELECT a.id,a.version_id,e.episode_id,e.project_id,p.tenant_id
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1 FOR SHARE`, [parentArtifactId])).rows[0];
      if (!child || !parent) throw Object.assign(new Error('artifact lineage endpoint not found'), { code: 'ARTIFACT_NOT_FOUND' });
      if (child.tenant_id !== parent.tenant_id || child.project_id !== parent.project_id || child.episode_id !== parent.episode_id) {
        throw Object.assign(new Error('artifact lineage crosses tenant/project/episode boundary'), { code: 'TENANT_SCOPE_VIOLATION' });
      }
      const evidenceDigest = digest(evidence);
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO artifact_lineage_edges
        (id,tenant_id,project_id,child_artifact_id,parent_artifact_id,child_version_id,parent_version_id,relation,evidence_digest,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (child_artifact_id,parent_artifact_id,relation) DO NOTHING RETURNING *`,
        [id, child.tenant_id, child.project_id, child.id, parent.id, child.version_id, parent.version_id, relation, evidenceDigest, actor]);
      const row = inserted.rows[0] || (await client.query(`SELECT * FROM artifact_lineage_edges
        WHERE child_artifact_id=$1 AND parent_artifact_id=$2 AND relation=$3 FOR SHARE`, [child.id, parent.id, relation])).rows[0];
      if (!row) throw Object.assign(new Error('artifact lineage write race'), { code: 'LINEAGE_RACE' });
      await client.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details)
        VALUES($1,$2,$3,$4,'artifact_lineage',$5,$6::jsonb)`,
        [child.project_id, child.episode_id, actor, inserted.rows[0] ? 'ARTIFACT_LINEAGE_RECORDED' : 'ARTIFACT_LINEAGE_DEDUPLICATED', child.id, JSON.stringify({ parentArtifactId: parent.id, relation, evidenceDigest })]);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureArtifactLineage({ artifactId, inputVersionIds = [], actor = 'artifact-storage' }) {
    const artifact = (await this.pool.query(`SELECT a.*,e.project_id,e.tenant_id,p.tenant_id AS tenant_scope
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1`, [artifactId])).rows[0];
    if (!artifact) throw Object.assign(new Error('artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
    const versions = [...new Set(Array.isArray(inputVersionIds) ? inputVersionIds.filter(Boolean) : [])];
    const parents = versions.length ? (await this.pool.query(`SELECT DISTINCT ON (a.version_id) a.id,a.version_id,e.project_id,p.tenant_id
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      WHERE a.version_id=ANY($1::text[]) AND e.episode_id=$2 AND p.id=$3 AND p.tenant_id=$4
      ORDER BY a.version_id,a.created_at DESC,a.id`, [versions, artifact.episode_id, artifact.project_id, artifact.tenant_scope])).rows : [];
    const edges = [];
    for (const parent of parents) {
      this._cancelled();
      edges.push(await this.recordArtifactLineage({ childArtifactId: artifact.id, parentArtifactId: parent.id, relation: 'DERIVED_FROM', actor, evidence: { inputVersionId: parent.version_id } }));
    }
    return { artifactId, parentCount: edges.length, edges };
  }

  async _quarantine(client, artifact, objectId, reason) {
    await client.query(`UPDATE storage_objects SET status='CORRUPT',checksum_verified=false,metadata=metadata||$2::jsonb
      WHERE artifact_id=$1`, [artifact.id, JSON.stringify({ integrityQuarantine: true, integrityReason: reason, quarantinedAt: new Date().toISOString() })]);
    try {
      await client.query(`UPDATE artifact_content_objects SET status='QUARANTINED',checksum_verified=false
        WHERE tenant_id=$1 AND id=$2 AND status <> 'DELETED'`, [artifact.tenant_id, objectId]);
    } catch (error) {
      if (!['42P01', '42703'].includes(error.code)) throw error;
    }
  }

  async scan({ tenantId, projectId = null, limit = 100, actor = 'integrity-scanner' } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required');
    const scanLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const runId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this._scope(client, tenantId, projectId);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`forge-artifact-integrity:${tenantId}:${projectId || '*'}`]);
      await client.query(`INSERT INTO artifact_integrity_runs(id,tenant_id,project_id,status,scan_limit) VALUES($1,$2,$3,'RUNNING',$4)`, [runId, tenantId, projectId, scanLimit]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw error;
    }
    client.release();

    let scanned = 0, verified = 0, missing = 0, corrupt = 0, quarantined = 0;
    const rows = (await this.pool.query(`SELECT a.id,a.kind,a.version_id,a.content_hash,a.media_type,a.metadata,e.project_id,p.tenant_id,
        s.id AS storage_object_id,s.storage_key,s.status AS storage_status,s.content_hash AS stored_hash,s.size_bytes
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      LEFT JOIN storage_objects s ON s.artifact_id=a.id
      WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      ORDER BY a.created_at,a.id LIMIT $3`, [tenantId, projectId, scanLimit])).rows;

    for (const artifact of rows) {
      this._cancelled();
      scanned += 1;
      let finding = 'VERIFIED';
      let observedHash = null;
      let observedSize = null;
      let diagnostics = {};
      try {
        if (!artifact.storage_key || !artifact.content_hash || !artifact.storage_object_id) {
          throw Object.assign(new Error('trusted storage metadata is missing'), { code: 'ARTIFACT_MISSING_STORAGE' });
        }
        if (artifact.storage_status !== 'READY' || (artifact.stored_hash && artifact.stored_hash !== artifact.content_hash)) {
          throw Object.assign(new Error('storage metadata checksum/state mismatch'), { code: 'ARTIFACT_METADATA_MISMATCH' });
        }
        const resolved = await this.storage.download({ key: artifact.storage_key, expectedSha256: artifact.content_hash });
        observedSize = await drain(resolved.stream);
        observedHash = artifact.content_hash;
        if (Number(artifact.size_bytes) !== observedSize) throw Object.assign(new Error('stored size differs from metadata'), { code: 'SIZE_MISMATCH' });
        verified += 1;
      } catch (error) {
        if (error.code === 'ARTIFACT_NOT_FOUND') { finding = 'MISSING'; missing += 1; }
        else if (error.code === 'ARTIFACT_METADATA_MISMATCH') { finding = 'METADATA_MISMATCH'; corrupt += 1; }
        else { finding = 'CORRUPT'; corrupt += 1; }
        diagnostics = { code: error.code || 'INTEGRITY_FAILURE', message: error.message };
        const q = await this.pool.connect();
        try {
          await q.query('BEGIN');
          await this._quarantine(q, artifact, artifact.storage_object_id, finding);
          await q.query(`INSERT INTO artifact_integrity_findings
            (id,run_id,tenant_id,project_id,artifact_id,object_id,finding,expected_sha256,observed_sha256,expected_size_bytes,observed_size_bytes,state,diagnostics)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'QUARANTINED',$12::jsonb)
            ON CONFLICT(run_id,artifact_id,finding) DO UPDATE SET diagnostics=EXCLUDED.diagnostics,state='QUARANTINED'`,
            [randomUUID(), runId, tenantId, artifact.project_id, artifact.id, artifact.storage_object_id, finding, artifact.content_hash, observedHash, artifact.size_bytes, observedSize, JSON.stringify(diagnostics)]);
          await q.query('COMMIT');
          quarantined += 1;
        } catch (quarantineError) {
          await q.query('ROLLBACK').catch(() => {});
          this.logger.error?.('artifact integrity quarantine failed', { artifactId: artifact.id, error: quarantineError.message });
        } finally { q.release(); }
        continue;
      }
      await this.pool.query(`INSERT INTO artifact_integrity_findings
        (id,run_id,tenant_id,project_id,artifact_id,object_id,finding,expected_sha256,observed_sha256,expected_size_bytes,observed_size_bytes,state,diagnostics)
        VALUES($1,$2,$3,$4,$5,$6,'VERIFIED',$7,$8,$9,$10,'REPAIRED',$11::jsonb)
        ON CONFLICT(run_id,artifact_id,finding) DO UPDATE SET state='REPAIRED',diagnostics=EXCLUDED.diagnostics`,
        [randomUUID(), runId, tenantId, artifact.project_id, artifact.id, artifact.storage_object_id, artifact.content_hash, observedHash, artifact.size_bytes, observedSize, JSON.stringify({ actor })]);
    }
    await this.pool.query(`UPDATE artifact_integrity_runs SET status='SUCCEEDED',scanned_count=$2,verified_count=$3,missing_count=$4,corrupt_count=$5,quarantined_count=$6,
      cursor_created_at=now(),diagnostics=$7::jsonb,finished_at=now() WHERE id=$1`,
      [runId, scanned, verified, missing, corrupt, quarantined, JSON.stringify({ actor, projectId, limit: scanLimit })]);
    this.metrics?.inc?.('forge_artifact_integrity_scans_total', { outcome: corrupt || missing ? 'findings' : 'clean' });
    return { runId, tenantId, projectId, scanned, verified, missing, corrupt, quarantined };
  }

  async rebuildContentReference({ tenantId, artifactId, actor = 'integrity-repair' }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const artifact = (await client.query(`SELECT a.*,e.project_id,p.tenant_id,s.storage_key,s.content_hash stored_hash,s.size_bytes,s.status
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
        LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1 AND p.tenant_id=$2 FOR UPDATE`, [artifactId, tenantId])).rows[0];
      if (!artifact) throw Object.assign(new Error('artifact not found in tenant'), { code: 'TENANT_SCOPE_VIOLATION' });
      if (!artifact.content_hash || !artifact.storage_key || artifact.status !== 'READY') throw Object.assign(new Error('artifact cannot be rebuilt until storage is verified'), { code: 'REPAIR_REQUIRES_VERIFIED_STORAGE' });
      const object = (await client.query(`SELECT * FROM artifact_content_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE`, [tenantId, artifact.content_hash])).rows[0];
      let objectId = object?.id;
      if (!objectId) {
        objectId = randomUUID();
        await client.query(`INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,true,'READY',$8::jsonb)`, [objectId, tenantId, artifact.content_hash, artifact.size_bytes, artifact.media_type || 'application/octet-stream', artifact.kind, artifact.storage_key, JSON.stringify({ rebuiltBy: actor })]);
      } else if (object.status === 'DELETED') throw Object.assign(new Error('content object is deleted'), { code: 'REPAIR_REQUIRES_RECOVERY' });
      const existing = (await client.query('SELECT * FROM artifact_content_refs WHERE artifact_id=$1 AND tenant_id=$2 FOR UPDATE', [artifactId, tenantId])).rows[0];
      if (!existing) {
        await client.query(`INSERT INTO artifact_content_refs(id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active)
          VALUES($1,$2,$3,$4,$5,'IMMUTABLE',$6,true)`, [randomUUID(), tenantId, artifact.project_id, artifactId, objectId, artifact.version_id]);
      } else if (existing.object_id !== objectId) {
        throw Object.assign(new Error('artifact content reference points at a different immutable object'), { code: 'REPAIR_SCOPE_CONFLICT' });
      }
      await client.query(`UPDATE artifact_integrity_findings SET state='REPAIRED',resolved_at=now() WHERE tenant_id=$1 AND artifact_id=$2 AND state IN ('OPEN','QUARANTINED')`, [tenantId, artifactId]);
      await client.query(`INSERT INTO artifact_integrity_repairs(id,tenant_id,project_id,artifact_id,action,state,idempotency_key,actor,diagnostics,finished_at)
        VALUES($1,$2,$3,$4,'REBUILD_LEDGER_REF','SUCCEEDED',$5,$6,$7::jsonb,now()) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
        [randomUUID(), tenantId, artifact.project_id, artifactId, `rebuild-ref:${artifactId}:${artifact.content_hash}`, actor, JSON.stringify({ objectId })]);
      await client.query('COMMIT');
      return { artifactId, objectId, state: 'REBUILT' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async requestRepair({ tenantId, projectId, artifactId, action = 'RETRY_VERIFY', actor = 'operator' }) {
    if (!['REBUILD_LEDGER_REF', 'REBUILD_STORAGE_METADATA', 'RESTORE_FROM_RECOVERY', 'RETRY_VERIFY', 'QUARANTINE'].includes(action)) throw new TypeError('unsupported repair action');
    await this._scope(this.pool, tenantId, projectId);
    const idempotencyKey = `repair:${artifactId}:${action}`;
    const result = await this.pool.query(`INSERT INTO artifact_integrity_repairs(id,tenant_id,project_id,artifact_id,action,state,idempotency_key,actor)
      VALUES($1,$2,$3,$4,$5,'REQUESTED',$6,$7) ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET actor=EXCLUDED.actor RETURNING *`,
      [randomUUID(), tenantId, projectId, artifactId, action, idempotencyKey, actor]);
    return result.rows[0];
  }

  async health({ tenantId }) {
    const result = await this.pool.query(`SELECT
      count(*) FILTER (WHERE state IN ('OPEN','QUARANTINED'))::int AS open_findings,
      count(*) FILTER (WHERE finding='CORRUPT')::int AS corrupt_findings,
      count(*) FILTER (WHERE finding='MISSING')::int AS missing_findings
      FROM artifact_integrity_findings WHERE tenant_id=$1`, [tenantId]);
    return { tenantId, ...(result.rows[0] || { open_findings: 0, corrupt_findings: 0, missing_findings: 0 }), status: Number(result.rows[0]?.corrupt_findings || 0) || Number(result.rows[0]?.missing_findings || 0) ? 'DEGRADED' : 'HEALTHY' };
  }
}

module.exports = { ArtifactIntegrityControlPlane, digest, drain };
