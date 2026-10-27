#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { verifyPackageIntegrity } = require('../src/attestation/package-integrity');
const { attestPackage, SAFE_REATTEST_REASONS } = require('../src/attestation/package-attestation');

async function main() {
  const [command, packageArtifactId, reason] = process.argv.slice(2);
  if (!command || !packageArtifactId || !['verify', 'reattest'].includes(command)) throw new Error('usage: node scripts/package-attestation.js <verify|reattest> <package-artifact-id> [reason]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = command === 'verify'
      ? await verifyPackageIntegrity({ pool, packageArtifactId })
      : await reattest(pool, packageArtifactId, reason || 'TOOLCHAIN_MISMATCH');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === 'verify' && !result.ok) process.exitCode = 2;
  } finally { await pool.end(); }
}

async function reattest(pool, packageArtifactId, reason) {
  if (!SAFE_REATTEST_REASONS.has(reason)) throw Object.assign(new Error(`Re-attestation reason ${reason} is not safe`), { code: 'RE_ATTESTATION_UNSAFE' });
  const scope = (await pool.query(`SELECT p.tenant_id,e.project_id FROM episode_packages ep JOIN episodes e ON e.id=ep.episode_id JOIN projects p ON p.id=e.project_id WHERE ep.id=$1`, [packageArtifactId])).rows[0];
  if (!scope) throw Object.assign(new Error('Package not found'), { code: 'PACKAGE_NOT_FOUND' });
  const policy = (await pool.query(`SELECT COALESCE(MAX(revision),0)::bigint AS epoch FROM runtime_policy_heads WHERE scope_type='SYSTEM' OR (scope_type='TENANT' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2)`, [scope.tenant_id, scope.project_id])).rows[0]?.epoch;
  const current = await verifyPackageIntegrity({ pool, packageArtifactId, policyEpoch: policy == null ? null : Number(policy) });
  const unsafe = current.diagnostics.filter((item) => item.code !== 'ATTESTATION_MISSING' && !SAFE_REATTEST_REASONS.has(item.code));
  if (unsafe.length) throw Object.assign(new Error('Re-attestation has unsafe integrity diagnostics'), { code: 'RE_ATTESTATION_UNSAFE', diagnostics: unsafe });
  return attestPackage({ pool, packageArtifactId, operator: process.env.FORGE_STATIC_ACTOR_ID || 'operator-cli', reason, reattest: true, operatorApproved: process.env.FORGE_REATTEST_APPROVED === 'true', policyEpoch: policy == null ? null : Number(policy) });
}

main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'ATTESTATION_FAILED', message: error.message, diagnostics: error.diagnostics || [] }, null, 2)); process.exitCode = 1; });
