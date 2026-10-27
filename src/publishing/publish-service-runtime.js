'use strict';

const { PublishService } = require('./publish-service');
const { MediaValidationService } = require('../media/content-validation');

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
  async gate(run) {
    const result = super.gate(run);
    await this.mediaValidator.assertPublishable({ tenantId: run.tenant_id, projectId: run.project_id, artifactId: run.render_artifact_id, versionId: run.render_version_id });
    return result;
  }
}

module.exports = { RuntimePublishService };
