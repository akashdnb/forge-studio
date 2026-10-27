'use strict';
const { Pool } = require('pg');
const { KeyManagementService } = require('../src/crypto/key-management');
const { ReencryptionJobService } = require('../src/crypto/reencryption-worker');
const { createReencryptionHandlers } = require('../src/crypto/reencryption-handlers');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.FORGE_SECRET_ENCRYPTION_KEY) throw new Error('FORGE_SECRET_ENCRYPTION_KEY is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const kms = new KeyManagementService({ pool, rootKey: process.env.FORGE_SECRET_ENCRYPTION_KEY });
    const service = new ReencryptionJobService({ pool, kms, workerId: process.env.FORGE_CRYPTO_WORKER_ID });
    const job = await service.claim();
    if (!job) { console.log(JSON.stringify({ status: 'idle' })); return; }
    const handlers = createReencryptionHandlers({ pool, kms });
    const result = await service.runOne(job, handlers);
    console.log(JSON.stringify({ status: 'processed', jobId: job.id, state: result?.status, processedCount: result?.processed_count }));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'REENCRYPTION_FAILED', message: error.message })); process.exitCode = 1; });
