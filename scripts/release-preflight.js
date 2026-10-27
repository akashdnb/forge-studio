const fs = require('node:fs/promises');
const path = require('node:path');
const { ReleaseSafetyService } = require('../src/release-safety/release-safety');

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  try {
    const manifestFile = arg('--manifest', process.env.FORGE_RELEASE_MANIFEST || null);
    if (!manifestFile) throw new Error('--manifest or FORGE_RELEASE_MANIFEST is required');
    const manifest = JSON.parse(await fs.readFile(path.resolve(manifestFile), 'utf8'));
    const service = new ReleaseSafetyService({ pool });
    const result = await service.preflight(manifest);
    const evidence = { ok: result.ok, releaseId: result.manifest.releaseId, manifestHash: result.manifest.manifestHash, migration: { pending: result.migration.pending.map((m) => m.name), checksumMismatches: result.migration.checksumMismatches, unsafePending: result.migration.unsafePending, duplicatePendingNumbers: result.migration.duplicatePendingNumbers }, schemaHash: result.schema.hash, missingIndexes: result.missingIndexes, missingConfig: result.missingConfig, missingDependencies: result.missingDependencies, issues: result.issues };
    console.log(JSON.stringify(evidence, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || 'RELEASE_PREFLIGHT_FAILED', message: error.message })); process.exitCode = 1; });
