'use strict';

const { executePackaging } = require('./worker');
const { attestPackage, loadPackageContext, canonicalJson, sha256 } = require('../attestation/package-attestation');

async function executeAttestedPackaging({ pool, storage, payload, job, signal, toolchain = null, policyEpoch = null } = {}) {
  const result = await executePackaging({ pool, storage, payload, job, signal });
  if (!result?.packageArtifactId) throw Object.assign(new Error('Packaging completed without a package artifact'), { code: 'ATTESTATION_PACKAGE_MISSING', retryable: true });
  const attestation = await attestPackage({ pool, packageArtifactId: result.packageArtifactId, operator: job?.created_by || 'package-worker', reason: 'package-build', toolchain, policyEpoch });
  const stored = (await pool.query('SELECT * FROM package_attestations WHERE id=$1', [attestation.attestationId])).rows[0];
  if (!stored) throw Object.assign(new Error('Package attestation was not persisted'), { code: 'ATTESTATION_PERSISTENCE_FAILED', retryable: true });
  const context = await loadPackageContext(pool, result.packageArtifactId);
  const dependencyInventoryHash = sha256(canonicalJson(context.dependencies));
  await pool.query(`INSERT INTO package_build_inputs(package_artifact_id,tenant_id,project_id,episode_id,package_manifest_hash,canonical_inputs_hash,dependency_inventory_hash,toolchain_fingerprint,release_epoch,policy_epoch,source_versions,dependency_inventory,canonical_inputs,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
    ON CONFLICT(package_artifact_id) DO NOTHING`, [result.packageArtifactId, stored.tenant_id, stored.project_id, stored.episode_id, context.packageRow.manifest_hash, stored.build_fingerprint, dependencyInventoryHash, stored.toolchain?.fingerprint || '0'.repeat(64), context.packageRow.release_epoch, policyEpoch == null ? null : Number(policyEpoch), JSON.stringify(stored.inputs.sourceVersionIds || []), JSON.stringify(context.dependencies), JSON.stringify(stored.inputs), job?.created_by || 'package-worker']);
  return { ...result, attestation };
}

module.exports = { executeAttestedPackaging };
