'use strict';

const { executePackaging } = require('./worker');
const { attestPackage } = require('../attestation/package-attestation');

async function executeAttestedPackaging({ pool, storage, payload, job, signal, toolchain = null, policyEpoch = null } = {}) {
  const result = await executePackaging({ pool, storage, payload, job, signal });
  if (!result?.packageArtifactId) throw Object.assign(new Error('Packaging completed without a package artifact'), { code: 'ATTESTATION_PACKAGE_MISSING', retryable: true });
  const attestation = await attestPackage({
    pool,
    packageArtifactId: result.packageArtifactId,
    operator: job?.created_by || 'package-worker',
    reason: 'package-build',
    toolchain,
    policyEpoch,
  });
  return { ...result, attestation };
}

module.exports = { executeAttestedPackaging };
