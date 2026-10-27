'use strict';

const { PublishService } = require('./publish-service');
const { verifyPackageAttestation } = require('../attestation/package-attestation');

class RuntimePublishService extends PublishService {
  async loadRun(runId) {
    const run = await super.loadRun(runId);
    if (!run) return null;
    return { ...run, package_id: run.package_artifact_id, package_version_id: run.package_version_id };
  }

  async assertPackageAttestation(run) {
    if (!run?.package_artifact_id) throw Object.assign(new Error('Publish request has no canonical package identity'), { code: 'PACKAGE_REQUIRED', retryable: false });
    const policy = (await this.pool.query(`SELECT COALESCE(MAX(revision),0)::bigint AS epoch FROM runtime_policy_heads WHERE scope_type='SYSTEM' OR (scope_type='TENANT' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2)`, [run.tenant_id, run.project_id])).rows[0]?.epoch;
    const verification = await verifyPackageAttestation({ pool: this.pool, packageArtifactId: run.package_artifact_id, policyEpoch: policy == null ? null : Number(policy) });
    if (!verification.ok) throw Object.assign(new Error(`Package attestation verification failed: ${verification.diagnostics.map((item) => item.code).join(', ')}`), { code: 'PACKAGE_ATTESTATION_BLOCKED', retryable: false, diagnostics: verification.diagnostics });
    return verification;
  }

  async publish(args = {}) {
    const run = await this.loadRun(args.runId);
    await this.assertPackageAttestation(run);
    return super.publish(args);
  }
}

module.exports = { RuntimePublishService };
