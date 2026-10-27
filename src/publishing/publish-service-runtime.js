'use strict';

const { PublishService } = require('./publish-service');

/**
 * Compatibility boundary for the legacy publish_runs/episode_packages schema.
 * `publish_runs.package_artifact_id` is the immutable artifact identity while
 * `episode_packages.id` is the package manifest record identity. The legacy
 * service query exposes both under overlapping aliases; normalize the gate
 * input so package identity is always compared against the artifact FK.
 */
class RuntimePublishService extends PublishService {
  async loadRun(runId) {
    const run = await super.loadRun(runId);
    if (!run) return null;
    return { ...run, package_id: run.package_artifact_id, package_version_id: run.package_version_id };
  }
}

module.exports = { RuntimePublishService };
