'use strict';

const { PublishService } = require('./publish-service');
const { verifyPackageAttestation } = require('../attestation/package-attestation');

class RuntimePublishService extends PublishService {
  async loadRun(runId) {
    const run = await super.loadRun(runId);
    if (!run) return null;
    return { ...run, package_id: run.package_artifact_id, package_version_id: run.package_version_id };
  }

  async gate(run) {
    super.gate(run);
    if (!run.package_artifact_id) throw Object.assign(new Error('Publish request has no canonical package identity'), { code: 'PACKAGE_REQUIRED', retryable: false });
    const verification = await verifyPackageAttestation({ pool: this.pool, packageArtifactId: run.package_artifact_id });
    if (!verification.ok) throw Object.assign(new Error(`Package attestation verification failed: ${verification.diagnostics.map((item) => item.code).join(', ')}`), { code: 'PACKAGE_ATTESTATION_BLOCKED', retryable: false, diagnostics: verification.diagnostics });
    return true;
  }
}

module.exports = { RuntimePublishService };
