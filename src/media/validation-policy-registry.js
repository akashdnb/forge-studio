'use strict';

const crypto = require('node:crypto');
const { DEFAULT_POLICY, stable } = require('./content-validation');

function fingerprint(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }

class MediaValidationPolicyRegistry {
  constructor({ pool } = {}) {
    if (!pool?.query) throw new TypeError('pool is required');
    this.pool = pool;
  }
  async create({ tenantId = null, projectId = null, versionId = null, policy = {}, createdBy = 'operator' }) {
    if (!tenantId && !projectId && !versionId) throw Object.assign(new Error('A tenant, project or version scope is required'), { code: 'POLICY_SCOPE_REQUIRED' });
    if (versionId && !projectId) throw Object.assign(new Error('Version-scoped policies require project scope'), { code: 'POLICY_SCOPE_REQUIRED' });
    const merged = { ...DEFAULT_POLICY, ...policy };
    const policyFingerprint = fingerprint(merged);
    const scope = versionId ? `version:${versionId}` : projectId ? `project:${projectId}` : `tenant:${tenantId}`;
    const id = `media-policy:${scope}:v${Date.now()}:${policyFingerprint.slice(0, 16)}`;
    const previous = await this.pool.query(`SELECT COALESCE(max(policy_version),0)::int AS version FROM media_validation_policies WHERE tenant_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2 AND version_id IS NOT DISTINCT FROM $3`, [tenantId, projectId, versionId]);
    const policyVersion = Number(previous.rows[0]?.version || 0) + 1;
    await this.pool.query('UPDATE media_validation_policies SET active=false,retired_at=now() WHERE active AND tenant_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2 AND version_id IS NOT DISTINCT FROM $3', [tenantId, projectId, versionId]);
    const result = await this.pool.query(`INSERT INTO media_validation_policies(id,tenant_id,project_id,version_id,policy_version,policy,policy_fingerprint,active,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,true,$8) RETURNING *`, [id, tenantId, projectId, versionId, policyVersion, JSON.stringify(merged), policyFingerprint, createdBy]);
    return result.rows[0];
  }
  async getEffective({ tenantId, projectId, versionId }) {
    const result = await this.pool.query(`SELECT * FROM media_validation_policies WHERE active AND ((version_id=$1) OR (version_id IS NULL AND project_id=$2) OR (version_id IS NULL AND project_id IS NULL AND tenant_id=$3)) ORDER BY CASE WHEN version_id=$1 THEN 1 WHEN project_id=$2 THEN 2 ELSE 3 END, policy_version DESC, created_at DESC LIMIT 1`, [versionId, projectId, tenantId]);
    return result.rows[0] || { id: null, policy_version: 0, policy: DEFAULT_POLICY, policy_fingerprint: fingerprint(DEFAULT_POLICY) };
  }
}

module.exports = { MediaValidationPolicyRegistry, fingerprint };
