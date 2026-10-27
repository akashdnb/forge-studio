'use strict';

const { Pool } = require('pg');
const { createStorageFromEnv } = require('../src/storage');
const { createDefaultDestinationRegistry } = require('../src/publishing/destination-contract');
const { PublishService } = require('../src/publishing/publish-service');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const runId = arg('--run-id'); if (!runId) throw new Error('--run-id is required');
  const command = process.argv[2] || 'reconcile';
  const actor = process.env.FORGE_ACTOR_ID || 'publish-operator';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const service = new PublishService({ pool, storage: createStorageFromEnv(), registry: createDefaultDestinationRegistry({ pool }), logger: console });
  try {
    if (command === 'reconcile') console.log(JSON.stringify(await service.reconcile(runId, actor), null, 2));
    else if (command === 'retry') console.log(JSON.stringify(await service.retry(runId, actor), null, 2));
    else if (command === 'cancel') console.log(JSON.stringify(await service.cancel(runId, actor, arg('--reason') || 'operator cancellation'), null, 2));
    else if (command === 'quarantine') console.log(JSON.stringify(await service.quarantine(runId, actor, arg('--reason') || 'operator quarantine'), null, 2));
    else throw new Error(`Unknown publish operator command: ${command}`);
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(JSON.stringify({ ok: false, code: error.code || 'PUBLISH_OPERATOR_FAILED', message: error.message })); process.exitCode = 1; });
