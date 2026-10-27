'use strict';
const { ProductionArtifactLifecycleControlPlane } = require('./artifact-lifecycle-production');

class FinalArtifactLifecycleControlPlane extends ProductionArtifactLifecycleControlPlane {
  async _isProtected(client, tenantId, objectId) {
    const activeRef = await client.query(`SELECT ref_kind FROM artifact_content_refs WHERE tenant_id=$1 AND object_id=$2 AND active=true LIMIT 1`, [tenantId, objectId]);
    if (activeRef.rows[0]) return { protected: true, reason: `ACTIVE_REFERENCE:${activeRef.rows[0].ref_kind}` };
    return super._isProtected(client, tenantId, objectId);
  }
}

module.exports = { FinalArtifactLifecycleControlPlane };
