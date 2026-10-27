'use strict';

const { drain } = require('./artifact-integrity-control-plane');

async function verifyAndRebuildContentReference(service, { tenantId, artifactId, actor = 'integrity-repair' } = {}) {
  const row = (await service.pool.query(`SELECT a.id,a.content_hash,s.storage_key,s.size_bytes,s.status,e.project_id,p.tenant_id
    FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
    LEFT JOIN storage_objects s ON s.artifact_id=a.id
    WHERE a.id=$1 AND p.tenant_id=$2`, [artifactId, tenantId])).rows[0];
  if (!row) throw Object.assign(new Error('artifact not found in tenant'), { code: 'TENANT_SCOPE_VIOLATION' });
  if (!row.content_hash || !row.storage_key || row.status !== 'READY') throw Object.assign(new Error('artifact storage is not eligible for ledger rebuild'), { code: 'REPAIR_REQUIRES_VERIFIED_STORAGE' });
  const resolved = await service.storage.download({ key: row.storage_key, expectedSha256: row.content_hash });
  const bytes = await drain(resolved.stream);
  if (Number(row.size_bytes) !== bytes) throw Object.assign(new Error('verified artifact size differs from metadata'), { code: 'SIZE_MISMATCH' });
  return service.rebuildContentReference({ tenantId, artifactId, actor });
}

module.exports = { verifyAndRebuildContentReference };
