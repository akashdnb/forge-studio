#!/usr/bin/env node
const fs = require('node:fs');
const { Pool } = require('pg');
const { EpisodeBundleService } = require('../src/recovery/episode-bundle-service');

function usage() {
  console.error('Usage: node scripts/forge-bundle.js export-project <projectId> <output>');
  console.error('       node scripts/forge-bundle.js export-episode <episodeId> <output>');
  console.error('       node scripts/forge-bundle.js import <bundle> [targetProjectId] [--dry-run]');
  console.error('       node scripts/forge-bundle.js replay <episodeId> <stageKind> [sourceJobId]');
  process.exit(2);
}
async function main() {
  const [, , command, first, second, ...rest] = process.argv;
  if (!process.env.DATABASE_URL || !command || !first) usage();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  const service = new EpisodeBundleService({ pool });
  const actor = process.env.FORGE_STATIC_ACTOR_ID || process.env.USER || 'cli';
  const tenantId = process.env.FORGE_STATIC_TENANT_ID || `tenant:${actor}`;
  try {
    if (command === 'export-project') {
      const result = await service.exportBundle({ projectId: first, tenantId, actor }); await fs.promises.copyFile(result.archive, second || `${result.bundleId}.forge-bundle.tar.gz`); console.log(JSON.stringify(result, null, 2)); return;
    }
    if (command === 'export-episode') {
      const episode = (await pool.query('SELECT project_id FROM episodes WHERE id=$1', [first])).rows[0]; if (!episode) throw new Error('episode not found');
      const result = await service.exportBundle({ projectId: episode.project_id, episodeId: first, tenantId, actor }); await fs.promises.copyFile(result.archive, second || `${result.bundleId}.forge-bundle.tar.gz`); console.log(JSON.stringify(result, null, 2)); return;
    }
    if (command === 'import') {
      const result = await service.importBundle({ archivePath: first, tenantId, actor, targetProjectId: second?.startsWith('--') ? null : second, dryRun: rest.includes('--dry-run') || second === '--dry-run', allowMissingArtifacts: rest.includes('--allow-missing-artifacts') }); console.log(JSON.stringify(result, null, 2)); return;
    }
    if (command === 'replay') {
      const result = await service.createReplay({ tenantId, actor, episodeId: first, stageKind: second, sourceJobId: rest[0] || null }); console.log(JSON.stringify(result, null, 2)); return;
    }
    usage();
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(JSON.stringify({ error: { code: error.code || 'BUNDLE_CLI_FAILED', message: error.message } })); process.exitCode = 1; });
