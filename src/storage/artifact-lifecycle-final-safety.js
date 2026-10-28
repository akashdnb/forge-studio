'use strict';
const { ProductionArtifactLifecycleControlPlane } = require('./artifact-lifecycle-production');

class FinalArtifactLifecycleControlPlane extends ProductionArtifactLifecycleControlPlane {
  async _isProtected(client, tenantId, objectId) {
    const activeRef = await client.query(`SELECT ref_kind FROM artifact_content_refs WHERE tenant_id=$1 AND object_id=$2 AND active=true LIMIT 1`, [tenantId, objectId]);
    if (activeRef.rows[0]) return { protected: true, reason: `ACTIVE_REFERENCE:${activeRef.rows[0].ref_kind}` };
    return super._isProtected(client, tenantId, objectId);
  }

  async executeApprovedDeletes({ tenantId, generationId, actor = this.workerId, maxDeletes = 25, maxDeleteBytes = this.policy.maxDeleteBytes } = {}) {
    await this.pool.query(`UPDATE artifact_deletion_intents SET state='APPROVED' WHERE tenant_id=$1 AND generation_id=$2
      AND state='QUARANTINED' AND approval_required=false AND grace_until<=now()`, [tenantId, generationId]);
    const rows = (await this.pool.query(`SELECT d.*,o.status object_status,o.storage_key,o.sha256,o.size_bytes
      FROM artifact_deletion_intents d JOIN artifact_content_objects o ON o.id=d.object_id
      WHERE d.tenant_id=$1 AND d.generation_id=$2 AND d.state='APPROVED' AND d.grace_until<=now()
      ORDER BY d.id LIMIT $3`, [tenantId, generationId, Math.max(1, Number(maxDeletes))])).rows;
    let attempted = 0, deleted = 0, cancelled = 0, failed = 0, bytesDeleted = 0;
    for (const intent of rows) {
      this._cancelled();
      if (bytesDeleted + Number(intent.size_bytes) > Number(maxDeleteBytes)) break;
      const lock = await this.pool.connect();
      try {
        await lock.query('BEGIN');
        const current = (await lock.query(`SELECT d.*,o.status,o.storage_key,o.sha256,o.size_bytes
          FROM artifact_deletion_intents d JOIN artifact_content_objects o ON o.id=d.object_id
          WHERE d.id=$1 AND d.tenant_id=$2 FOR UPDATE OF d,o`, [intent.id, tenantId])).rows[0];
        if (!current || current.state !== 'APPROVED') { await lock.query('ROLLBACK'); continue; }
        const reservation = await lock.query(`SELECT 1 FROM artifact_storage_reservations
          WHERE object_id=$1 AND state='HELD' AND expires_at>now() LIMIT 1`, [current.object_id]);
        const protection = await this._isProtected(lock, tenantId, current.object_id);
        if (reservation.rows[0] || protection.protected) {
          const reason = protection.reason || 'ACTIVE_RESERVATION';
          await lock.query(`UPDATE artifact_deletion_intents SET state='CANCELLED',cancelled_at=now(),last_provider_error=$3::jsonb
            WHERE id=$1 AND tenant_id=$2 AND state='APPROVED'`, [current.id, tenantId, JSON.stringify({ code: 'PROTECTED', reason })]);
          await lock.query(`UPDATE artifact_content_objects SET status='READY'
            WHERE id=$1 AND tenant_id=$2 AND status='QUARANTINED'`, [current.object_id, tenantId]);
          await lock.query('COMMIT');
          cancelled++;
          continue;
        }
        const head = typeof this.storage.head === 'function' ? await this.storage.head(current.storage_key) : null;
        if (head && ((head.sha256 && head.sha256 !== current.sha256) || Number(head.sizeBytes) !== Number(current.size_bytes))) {
          throw Object.assign(new Error('storage checksum/size mismatch; deletion refused'), { code: 'STORAGE_INTEGRITY_MISMATCH', retryable: false });
        }
        await lock.query(`UPDATE artifact_deletion_intents SET state='DELETING',deleting_at=now(),provider_attempts=provider_attempts+1
          WHERE id=$1 AND tenant_id=$2 AND state='APPROVED'`, [current.id, tenantId]);

        // Keep the object row lock and transaction open across the provider side effect.
        // Any new reference/lease/reservation that must lock the object therefore cannot
        // become visible between the final protection check and storage.delete().
        await this.storage.delete(current.storage_key);
        const present = typeof this.storage.head === 'function' ? await this.storage.head(current.storage_key) : null;
        if (present) throw Object.assign(new Error('storage provider still reports object present'), { code: 'PROVIDER_RECONCILIATION_FAILED', retryable: true });

        const protectedAfterDelete = await this._isProtected(lock, tenantId, current.object_id);
        if (protectedAfterDelete.protected) {
          throw Object.assign(new Error('artifact became protected during fenced deletion'), { code: 'LATE_REFERENCE_AFTER_PROVIDER_DELETE', retryable: false, protection: protectedAfterDelete });
        }
        await lock.query(`UPDATE artifact_content_objects SET status='DELETED',deleted_at=now()
          WHERE id=$1 AND tenant_id=$2 AND status='QUARANTINED'`, [current.object_id, tenantId]);
        await lock.query(`UPDATE artifact_deletion_intents SET state='DELETED',deleted_at=now()
          WHERE id=$1 AND tenant_id=$2 AND state='DELETING'`, [current.id, tenantId]);
        await this._evidence(lock, { tenantId, projectId: current.project_id, objectId: current.object_id, generationId: current.generation_id, deletionIntentId: current.id, action: 'OBJECT_DELETED', actor, fenceToken: current.fence_token, payload: { storageKey: current.storage_key, sha256: current.sha256, sizeBytes: current.size_bytes } });
        await lock.query('COMMIT');
        deleted++;
        bytesDeleted += Number(current.size_bytes);
      } catch (error) {
        await lock.query('ROLLBACK').catch(() => {});
        failed++;
        await this._providerFailure(intent, error);
      } finally {
        lock.release();
        attempted++;
      }
    }
    const remaining = Number((await this.pool.query(`SELECT count(*)::int count FROM artifact_deletion_intents
      WHERE tenant_id=$1 AND generation_id=$2 AND state='APPROVED'`, [tenantId, generationId])).rows[0]?.count || 0);
    if (!remaining) await this.pool.query(`UPDATE artifact_gc_generations SET state='COMPLETED',finished_at=now()
      WHERE id=$1 AND tenant_id=$2 AND state IN ('SWEEPING','MARKED')`, [generationId, tenantId]);
    this.metrics?.inc?.('forge_artifact_gc_deletes_total', { outcome: 'complete' }, deleted);
    return { generationId, attempted, deleted, cancelled, failed, bytesDeleted, remaining };
  }

  async reconcileProvider({ tenantId, limit = 100 } = {}) {
    const intents = (await this.pool.query(`SELECT d.*,o.status object_status FROM artifact_deletion_intents d
      JOIN artifact_content_objects o ON o.id=d.object_id
      WHERE d.tenant_id=$1 AND d.state='DELETING' ORDER BY d.deleting_at NULLS FIRST,d.id LIMIT $2`, [tenantId, Math.max(1, Number(limit))])).rows;
    let recovered = 0, requeued = 0, failed = 0;
    for (const intent of intents) {
      try {
        const head = typeof this.storage.head === 'function' ? await this.storage.head(intent.storage_key) : null;
        if (!head) {
          if (await this._finalizeDelete(tenantId, intent.id, this.workerId)) recovered++;
          continue;
        }
        await this.pool.query(`UPDATE artifact_deletion_intents SET state='QUARANTINED',last_provider_error=$3::jsonb WHERE id=$1 AND tenant_id=$2 AND state='DELETING'`, [intent.id, tenantId, JSON.stringify({ code: 'CRASH_RECOVERY_PROVIDER_PRESENT', message: 'Deletion worker crashed after provider call; object remains quarantined' })]);
        await this.pool.query("UPDATE artifact_content_objects SET status='QUARANTINED' WHERE id=$1 AND tenant_id=$2 AND status<>'DELETED'", [intent.object_id, tenantId]);
        await this._recordReconciliation(tenantId, intent.object_id, intent.storage_key, Object.assign(new Error('provider object still present during deletion recovery'), { code: 'CRASH_RECOVERY_PROVIDER_PRESENT' }));
        requeued++;
      } catch (error) {
        failed++;
        await this._recordReconciliation(tenantId, intent.object_id, intent.storage_key, error).catch(() => {});
      }
    }
    const normal = await super.reconcileProvider({ tenantId, limit });
    return { ...normal, crashRecovery: { checked: intents.length, recovered, requeued, failed } };
  }
}

module.exports = { FinalArtifactLifecycleControlPlane };
