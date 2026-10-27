const { randomUUID } = require('node:crypto');

class ArtifactDuplicateCompactor {
  constructor({ pool, storage, logger = console, signal } = {}) {
    if (!pool?.connect || !pool?.query) throw new TypeError('pg pool is required');
    if (!storage || typeof storage.delete !== 'function') throw new TypeError('storage backend with delete() is required');
    this.pool = pool; this.storage = storage; this.logger = logger; this.signal = signal;
  }
  _cancelled() { return Boolean(this.signal?.aborted); }

  async compact({ tenantId, maxObjects = 25, maxBytes = Number.MAX_SAFE_INTEGER }) {
    let remainingBytes = Number.isFinite(Number(maxBytes)) ? Math.max(0, Number(maxBytes)) : Number.MAX_SAFE_INTEGER;
    const groups = await this.pool.query(`SELECT p.tenant_id,so.content_hash,COUNT(*)::int count
      FROM storage_objects so JOIN projects p ON p.id=so.project_id
      WHERE p.tenant_id=$1 AND so.content_hash IS NOT NULL AND so.storage_key IS NOT NULL AND so.status='READY'
      GROUP BY p.tenant_id,so.content_hash HAVING COUNT(*)>1 ORDER BY so.content_hash LIMIT $2`, [tenantId, Math.max(1, Math.min(Number(maxObjects), 100))]);
    let compacted = 0; let bytesReclaimed = 0; const errors = [];
    for (const group of groups.rows) {
      if (compacted >= Number(maxObjects) || remainingBytes <= 0) break;
      if (this._cancelled()) throw Object.assign(new Error('duplicate compaction cancelled'), { code: 'CANCELLED' });
      const client = await this.pool.connect();
      let duplicate = null; let tombstone = null;
      try {
        await client.query('BEGIN');
        const canonical = (await client.query(`SELECT * FROM artifact_content_objects WHERE tenant_id=$1 AND sha256=$2 AND status='READY' FOR UPDATE`, [tenantId, group.content_hash])).rows[0];
        if (!canonical) { await client.query('ROLLBACK'); continue; }
        const canonicalStorage = (await client.query(`SELECT * FROM storage_objects so JOIN projects p ON p.id=so.project_id WHERE p.tenant_id=$1 AND so.storage_key=$2 AND so.content_hash=$3 AND so.status='READY' ORDER BY so.created_at LIMIT 1 FOR UPDATE`, [tenantId, canonical.storage_key, group.content_hash])).rows[0];
        if (!canonicalStorage) { await client.query('ROLLBACK'); continue; }
        duplicate = (await client.query(`SELECT so.*,a.id artifact_id,p.tenant_id FROM storage_objects so JOIN artifacts a ON a.id=so.artifact_id JOIN projects p ON p.id=so.project_id WHERE p.tenant_id=$1 AND so.content_hash=$2 AND so.storage_key<>$3 AND so.status='READY' ORDER BY so.created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [tenantId, group.content_hash, canonical.storage_key])).rows[0];
        if (!duplicate || Number(duplicate.size_bytes || 0) > remainingBytes || Number(duplicate.size_bytes || 0) !== Number(canonical.size_bytes) || duplicate.checksum_verified !== true) { await client.query('ROLLBACK'); continue; }
        const ref = (await client.query(`SELECT object_id FROM artifact_content_refs WHERE artifact_id=$1 AND tenant_id=$2 AND active FOR SHARE`, [duplicate.artifact_id, tenantId])).rows[0];
        if (!ref || ref.object_id !== canonical.id) { await client.query('ROLLBACK'); continue; }
        tombstone = (await client.query(`INSERT INTO artifact_duplicate_tombstones(id,tenant_id,storage_object_id,object_id,old_storage_key,canonical_storage_key,state) VALUES($1,$2,$3,$4,$5,$6,'PENDING') RETURNING *`, [randomUUID(),tenantId,duplicate.id,canonical.id,duplicate.storage_key,canonical.storage_key])).rows[0];
        await client.query(`UPDATE storage_objects SET storage_key=$1,uri=$2,metadata=metadata||jsonb_build_object('deduplicatedInto',$3,'deduplicatedAt',now()) WHERE id=$4`, [canonicalStorage.storage_key, canonicalStorage.uri, canonical.id, duplicate.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); errors.push({ code: error.code || 'COMPACTION_FAILED', message: error.message }); continue; }
      finally { client.release(); }
      try {
        await this.storage.delete(tombstone.old_storage_key);
        const done = await this.pool.connect();
        try { await done.query(`UPDATE artifact_duplicate_tombstones SET state='DELETED',deleted_at=now() WHERE id=$1 AND state='PENDING'`, [tombstone.id]); } finally { done.release(); }
        compacted += 1; bytesReclaimed += Number(duplicate.size_bytes || 0); remainingBytes -= Number(duplicate.size_bytes || 0);
      } catch (error) {
        const fail = await this.pool.connect();
        try { await fail.query(`UPDATE artifact_duplicate_tombstones SET state='RETRY',last_error=$1::jsonb WHERE id=$2 AND state='PENDING'`, [JSON.stringify({ code: error.code || 'STORAGE_DELETE_FAILED', message: error.message }), tombstone.id]); } finally { fail.release(); }
        errors.push({ code: error.code || 'STORAGE_DELETE_FAILED', message: error.message, storageKey: tombstone.old_storage_key });
      }
    }
    return { tenantId, compacted, bytesReclaimed, errors };
  }
}

module.exports = { ArtifactDuplicateCompactor };
