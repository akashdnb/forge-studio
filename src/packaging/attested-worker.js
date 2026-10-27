'use strict';

const { executePackaging } = require('./worker');
const { attestPackage, loadPackageContext, canonicalJson, sha256 } = require('../attestation/package-attestation');
const { Observability } = require('../observability');
const { ProvenanceEvidenceGraph } = require('../provenance/evidence-graph');

async function executeAttestedPackaging({ pool, storage, payload, job, signal, toolchain = null, policyEpoch = null } = {}) {
  const observability = new Observability({ pool, service: 'forge-package-attestation' });
  try {
    const result = await executePackaging({ pool, storage, payload, job, signal });
    if (!result?.packageArtifactId) throw Object.assign(new Error('Packaging completed without a package artifact'), { code: 'ATTESTATION_PACKAGE_MISSING', retryable: true });
    const context = await loadPackageContext(pool, result.packageArtifactId);
    const policy = policyEpoch == null ? (await pool.query(`SELECT COALESCE(MAX(revision),0)::bigint AS epoch FROM runtime_policy_heads WHERE scope_type='SYSTEM' OR (scope_type='TENANT' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2)`, [context.packageRow.tenant_id, context.packageRow.project_id])).rows[0]?.epoch : Number(policyEpoch);
    const attestation = await attestPackage({ pool, packageArtifactId: result.packageArtifactId, operator: job?.created_by || 'package-worker', reason: 'package-build', toolchain, policyEpoch: policy == null ? null : Number(policy) });
    const stored = (await pool.query('SELECT * FROM package_attestations WHERE id=$1', [attestation.attestationId])).rows[0];
    if (!stored) throw Object.assign(new Error('Package attestation was not persisted'), { code: 'ATTESTATION_PERSISTENCE_FAILED', retryable: true });
    const dependencyInventoryHash = sha256(canonicalJson(context.dependencies));
    await pool.query(`INSERT INTO package_build_inputs(package_artifact_id,tenant_id,project_id,episode_id,package_manifest_hash,canonical_inputs_hash,dependency_inventory_hash,toolchain_fingerprint,release_epoch,policy_epoch,source_versions,dependency_inventory,canonical_inputs,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
      ON CONFLICT(package_artifact_id) DO NOTHING`, [result.packageArtifactId, stored.tenant_id, stored.project_id, stored.episode_id, context.packageRow.manifest_hash, stored.build_fingerprint, dependencyInventoryHash, stored.toolchain?.fingerprint || '0'.repeat(64), context.packageRow.release_epoch, policy == null ? null : Number(policy), JSON.stringify(stored.inputs.sourceVersionIds || []), JSON.stringify(context.dependencies), JSON.stringify(stored.inputs), job?.created_by || 'package-worker']);
    const provenance = new ProvenanceEvidenceGraph({ pool });
    await provenance.ensureArtifactChain({ artifactId: result.packageArtifactId, actor: job?.created_by || 'package-worker', reason: 'package-attested' });
    observability.metrics.inc('forge_package_attestation_total', { outcome: 'verified' });
    return { ...result, attestation };
  } catch (error) {
    observability.metrics.inc('forge_package_attestation_total', { outcome: 'blocked' });
    observability.metrics.inc('forge_package_attestation_diagnostics_total', { outcome: error.code || 'unknown' });
    throw error;
  }
}

module.exports = { executeAttestedPackaging };
