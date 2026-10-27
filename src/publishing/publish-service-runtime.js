'use strict';

const { PublishService } = require('./publish-service');
const { MediaValidationService } = require('../media/content-validation');
const { verifyPackageIntegrity } = require('../attestation/package-integrity');

/**
 * Compatibility boundary for the legacy publish_runs/episode_packages schema.
 * `publish_runs.package_artifact_id` is the immutable artifact identity while
 * `episode_packages.id` is the package manifest record identity. The legacy
 * service query exposes both under overlapping aliases; normalize the gate
 * input so package identity is always compared against the artifact FK.
 */
class RuntimePublishService extends PublishService {
  constructor(options = {}) {
    super(options);
    this.mediaValidator = new MediaValidationService({ pool: options.pool, workerId: process.env.FORGE_WORKER_ID || 'runtime-publish-validator', maxConcurrency: 1 });
  }
  async loadRun(runId) {
    const run = await super.loadRun(runId);
    if (!run) return null;
    return { ...run, package_id: run.package_artifact_id, package_version_id: run.package_version_id };
  }
  gate(run) { return super.gate(run); }
  async publish({ runId, job = {}, actor = 'worker' }) {
    const run = await this.loadRun(runId);
    if (run) {
      await this.mediaValidator.assertPublishable({ tenantId: run.tenant_id, projectId: run.project_id, artifactId: run.render_artifact_id, versionId: run.render_version_id });
      const policy=(await this.pool.query(`SELECT COALESCE(MAX(revision),0)::bigint AS epoch FROM runtime_policy_heads WHERE scope_type='SYSTEM' OR (scope_type='TENANT' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2)`,[run.tenant_id,run.project_id])).rows[0]?.epoch;
      const integrity=await verifyPackageIntegrity({pool:this.pool,packageArtifactId:run.package_artifact_id,policyEpoch:policy==null?null:Number(policy)});
      if(!integrity.ok)throw Object.assign(new Error(`Package attestation verification failed: ${integrity.diagnostics.map((item)=>item.code).join(', ')}`),{code:'PACKAGE_ATTESTATION_BLOCKED',retryable:false,diagnostics:integrity.diagnostics});
    }
    return super.publish({ runId, job, actor });
  }
}

module.exports = { RuntimePublishService };
