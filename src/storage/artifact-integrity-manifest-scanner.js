'use strict';

const { randomUUID } = require('node:crypto');
const { authenticateManifest, verifyManifest } = require('./artifact-integrity-manifest');

async function verifyArtifactManifests({ pool, tenantId, projectId = null, limit = 100, actor = 'integrity-scanner' }) {
  if (!pool?.query) throw new TypeError('pg-compatible pool is required');
  if (!tenantId) throw new TypeError('tenantId is required');
  const rows = (await pool.query(`SELECT m.*,s.status AS storage_status,s.encryption_mode AS storage_encryption_mode,s.encryption_key_id AS storage_encryption_key_id
    FROM artifact_integrity_manifests m
    JOIN artifacts a ON a.id=m.artifact_id
    JOIN episodes e ON e.id=a.episode_id
    JOIN projects p ON p.id=e.project_id
    LEFT JOIN storage_objects s ON s.artifact_id=a.id
    WHERE m.tenant_id=$1 AND ($2::text IS NULL OR m.project_id=$2)
    ORDER BY m.created_at,m.id LIMIT $3`, [tenantId, projectId, Math.max(1, Math.min(Number(limit) || 100, 500))])).rows;
  let verified = 0, invalid = 0, encryptionMismatch = 0;
  for (const row of rows) {
    const manifest = {
      tenantId: row.tenant_id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      versionId: row.version_id,
      kind: row.kind,
      storageKey: row.storage_key,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      mediaType: row.media_type,
      encryptionMode: row.encryption_mode,
      encryptionKeyId: row.encryption_key_id,
    };
    const valid = verifyManifest(manifest, row.manifest_mac);
    const encryptionOk = !row.storage_encryption_mode || row.storage_encryption_mode === row.encryption_mode;
    if (valid && encryptionOk) {
      verified += 1;
      continue;
    }
    if (!encryptionOk) encryptionMismatch += 1;
    invalid += 1;
    await pool.query(`UPDATE storage_objects SET status='CORRUPT',checksum_verified=false,metadata=metadata||$2::jsonb WHERE artifact_id=$1`, [row.artifact_id, JSON.stringify({ integrityQuarantine: true, integrityReason: encryptionOk ? 'MANIFEST_AUTHENTICATION_FAILED' : 'ENCRYPTION_METADATA_MISMATCH', quarantinedAt: new Date().toISOString() })]);
    const runId = randomUUID();
    await pool.query(`INSERT INTO artifact_integrity_runs(id,tenant_id,project_id,status,scan_limit,scanned_count,verified_count,corrupt_count,quarantined_count,diagnostics,started_at,finished_at)
      VALUES($1,$2,$3,'SUCCEEDED',1,1,0,1,1,$4::jsonb,now(),now())`, [runId, tenantId, row.project_id, JSON.stringify({ actor, artifactId: row.artifact_id, manifestInvalid: !valid, encryptionMismatch: !encryptionOk })]);
    await pool.query(`INSERT INTO artifact_integrity_findings
      (id,run_id,tenant_id,project_id,artifact_id,object_id,finding,expected_sha256,observed_sha256,expected_size_bytes,observed_size_bytes,state,diagnostics)
      SELECT $1,$2,$3,$4,$5,s.id,'METADATA_MISMATCH',$6,NULL,$7,NULL,'QUARANTINED',$8::jsonb FROM storage_objects s WHERE s.artifact_id=$5
      ON CONFLICT(run_id,artifact_id,finding) DO NOTHING`, [randomUUID(), runId, tenantId, row.project_id, row.artifact_id, row.sha256, row.size_bytes, JSON.stringify({ code: encryptionOk ? 'MANIFEST_AUTHENTICATION_FAILED' : 'ENCRYPTION_METADATA_MISMATCH', actor })]);
  }
  return { scanned: rows.length, verified, invalid, encryptionMismatch };
}

async function rebuildArtifactIntegrityManifest({ pool, tenantId, artifactId, actor = 'integrity-repair' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT a.id artifact_id,a.version_id,a.kind,e.project_id,p.tenant_id,a.content_hash,s.storage_key,s.size_bytes,s.media_type,s.encryption_mode,s.encryption_key_id,s.status
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      JOIN storage_objects s ON s.artifact_id=a.id
      WHERE a.id=$1 AND p.tenant_id=$2 FOR UPDATE`, [artifactId, tenantId])).rows[0];
    if (!row) throw Object.assign(new Error('artifact not found in tenant'), { code: 'TENANT_SCOPE_VIOLATION' });
    if (row.status !== 'READY' || !row.storage_key || !row.content_hash) throw Object.assign(new Error('artifact storage must be READY before manifest repair'), { code: 'REPAIR_REQUIRES_VERIFIED_STORAGE' });
    const manifest = { tenantId: row.tenant_id, projectId: row.project_id, artifactId: row.artifact_id, versionId: row.version_id, kind: row.kind, storageKey: row.storage_key, sha256: row.content_hash, sizeBytes: Number(row.size_bytes), mediaType: row.media_type, encryptionMode: row.encryption_mode || 'NONE', encryptionKeyId: row.encryption_key_id || null };
    const auth = authenticateManifest(manifest);
    const id = randomUUID();
    const inserted = (await client.query(`INSERT INTO artifact_integrity_manifests
      (id,tenant_id,project_id,artifact_id,version_id,content_identity,sha256,size_bytes,media_type,kind,storage_key,encryption_mode,encryption_key_id,manifest_digest,manifest_mac,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (artifact_id) DO UPDATE SET created_by=EXCLUDED.created_by
      RETURNING id`, [id,row.tenant_id,row.project_id,row.artifact_id,row.version_id,`sha256:${row.content_hash}`,row.content_hash,row.size_bytes,row.media_type,row.kind,row.storage_key,manifest.encryptionMode,manifest.encryptionKeyId,auth.digest,auth.mac,actor])).rows[0];
    await client.query(`UPDATE storage_objects SET integrity_manifest_id=$2,checksum_verified=true,status='READY' WHERE artifact_id=$1`, [artifactId, inserted.id]);
    await client.query(`UPDATE artifact_integrity_findings SET state='REPAIRED',resolved_at=now() WHERE tenant_id=$1 AND artifact_id=$2 AND state IN ('OPEN','QUARANTINED')`, [tenantId, artifactId]);
    await client.query('COMMIT');
    return { artifactId, manifestId: inserted.id, manifestDigest: auth.digest, state: 'REPAIRED' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { verifyArtifactManifests, rebuildArtifactIntegrityManifest };
