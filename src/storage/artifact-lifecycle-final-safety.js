'use strict';
const { ProductionArtifactLifecycleControlPlane } = require('./artifact-lifecycle-production');
const { randomUUID } = require('node:crypto');

class FinalArtifactLifecycleControlPlane extends ProductionArtifactLifecycleControlPlane {
  async _isProtected(client, tenantId, objectId) {
    const activeRef = await client.query(`SELECT ref_kind FROM artifact_content_refs WHERE tenant_id=$1 AND object_id=$2 AND active=true LIMIT 1`, [tenantId, objectId]);
    if (activeRef.rows[0]) return { protected: true, reason: `ACTIVE_REFERENCE:${activeRef.rows[0].ref_kind}` };
    return super._isProtected(client, tenantId, objectId);
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
