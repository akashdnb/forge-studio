#!/usr/bin/env node
const path = require('node:path');
const { Pool } = require('pg');
const { BackupService } = require('../src/recovery/backup-service');
const { createStorageFromEnv } = require('../src/storage');

function usage() {
  console.error(`Usage:\n  node scripts/forge-recovery.js backup [--dry-run] [--no-verify]\n  node scripts/forge-recovery.js verify <archive>\n  node scripts/forge-recovery.js restore <archive> <target-database-url> [--dry-run]\n  node scripts/forge-recovery.js retention`);
  process.exitCode = 2;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return usage();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  const service = new BackupService({ pool, storage: createStorageFromEnv() });
  try {
    if (command === 'backup') console.log(JSON.stringify(await service.createBackup({ actor: process.env.FORGE_STATIC_ACTOR_ID || 'system', reason: 'manual-cli', dryRun: args.includes('--dry-run'), verifyContent: !args.includes('--no-verify') }), null, 2));
    else if (command === 'verify' && args[0]) console.log(JSON.stringify(await service.verifyBackup({ archivePath: path.resolve(args[0]) }), null, 2));
    else if (command === 'restore' && args[0] && args[1]) console.log(JSON.stringify(await service.restore({ archivePath: path.resolve(args[0]), targetDatabaseUrl: args[1], actor: process.env.FORGE_STATIC_ACTOR_ID || 'system', dryRun: args.includes('--dry-run') }), null, 2));
    else if (command === 'retention') console.log(JSON.stringify(await service.applyRetention(), null, 2));
    else return usage();
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(JSON.stringify({ code: error.code || 'RECOVERY_FAILED', message: error.message })); process.exitCode = 1; });
