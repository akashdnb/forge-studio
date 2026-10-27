'use strict';

const { verifyPackageAttestation } = require('./package-attestation');

async function verifyPackageIntegrity({ pool, packageArtifactId, policyEpoch = null } = {}) {
  const verification = await verifyPackageAttestation({ pool, packageArtifactId, policyEpoch });
  const packageRow = (await pool.query(`SELECT ep.id,ep.manifest_hash,ep.final_media_artifact_id,ep.final_media_version_id,pa.content_hash AS artifact_hash,ps.content_hash AS storage_hash,ps.status AS storage_status
    FROM episode_packages ep
    JOIN artifacts pa ON pa.id=ep.id
    LEFT JOIN storage_objects ps ON ps.artifact_id=pa.id
    WHERE ep.id=$1`, [packageArtifactId])).rows[0];
  const diagnostics = [...verification.diagnostics];
  if (!packageRow) diagnostics.push({ code: 'PACKAGE_NOT_FOUND', severity: 'ERROR' });
  else {
    if (packageRow.artifact_hash !== packageRow.manifest_hash) diagnostics.push({ code: 'CHECKSUM_DRIFT', severity: 'ERROR', expected: packageRow.manifest_hash, actual: packageRow.artifact_hash });
    if (packageRow.storage_hash !== packageRow.manifest_hash) diagnostics.push({ code: 'CHECKSUM_DRIFT', severity: 'ERROR', expected: packageRow.manifest_hash, actual: packageRow.storage_hash });
    if (packageRow.storage_status !== 'READY') diagnostics.push({ code: 'PACKAGE_STORAGE_UNREADY', severity: 'ERROR', actual: packageRow.storage_status || 'MISSING' });
  }
  const dependencyRows = await pool.query(`SELECT a.id,a.version_id,a.content_hash,a.input_version_ids FROM artifacts a JOIN episode_packages ep ON ep.episode_id=a.episode_id WHERE ep.id=$1 AND a.content_hash IS NOT NULL`, [packageArtifactId]);
  const knownVersions = new Set(dependencyRows.rows.map((row) => row.version_id));
  const missing = new Set();
  for (const row of dependencyRows.rows) for (const versionId of (Array.isArray(row.input_version_ids) ? row.input_version_ids : [])) if (!knownVersions.has(versionId)) missing.add(versionId);
  if (missing.size) diagnostics.push({ code: 'MISSING_DEPENDENCY', severity: 'ERROR', versionIds: [...missing].sort() });
  return { ...verification, ok: diagnostics.length === 0, diagnostics, status: diagnostics.length ? 'DRIFTED' : 'VERIFIED' };
}

module.exports = { verifyPackageIntegrity };
