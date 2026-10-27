#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { verifyPackageAttestation, attestPackage } = require('../src/attestation/package-attestation');

async function main() {
  const [command, packageArtifactId, reason] = process.argv.slice(2);
  if (!command || !packageArtifactId || !['verify', 'reattest'].includes(command)) throw new Error('usage: node scripts/package-attestation.js <verify|reattest> <package-artifact-id> [reason]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = command === 'verify'
      ? await verifyPackageAttestation({ pool, packageArtifactId })
      : await attestPackage({ pool, packageArtifactId, operator: process.env.FORGE_STATIC_ACTOR_ID || 'operator-cli', reason: reason || 'TOOLCHAIN_MISMATCH', reattest: true, operatorApproved: process.env.FORGE_REATTEST_APPROVED === 'true' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === 'verify' && !result.ok) process.exitCode = 2;
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'ATTESTATION_FAILED', message: error.message, diagnostics: error.diagnostics || [] }, null, 2)); process.exitCode = 1; });
