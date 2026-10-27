'use strict';

const { ArtifactIntegrityControlPlane } = require('./artifact-integrity-control-plane');
const { createStorageFromEnv } = require('./index');

function createArtifactIntegrityHandlers({ pool, storage = createStorageFromEnv(), workerId = 'artifact-integrity-worker' } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const service = () => new ArtifactIntegrityControlPlane({ pool, storage, logger: console });
  return {
    'workflow:artifact-integrity-scan': async (payload = {}) => service().scan({
      tenantId: payload.tenantId,
      projectId: payload.projectId || null,
      limit: payload.limit || Number(process.env.FORGE_ARTIFACT_INTEGRITY_SCAN_LIMIT || 100),
      actor: workerId,
    }),
    'workflow:artifact-integrity-rebuild': async (payload = {}) => service().rebuildContentReference({
      tenantId: payload.tenantId,
      artifactId: payload.artifactId,
      actor: workerId,
    }),
  };
}

module.exports = { createArtifactIntegrityHandlers };
