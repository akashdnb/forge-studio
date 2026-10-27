const { CrossSystemIntegrityReconciler, canonicalJson, checksum } = require('../src/reconciliation/cross-system-integrity');
const { createStorageFromEnv } = require('../src/storage');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  const reconciler = new CrossSystemIntegrityReconciler({
    pool,
    storage: createStorageFromEnv(),
    pageSize: Number.parseInt(process.env.FORGE_INTEGRITY_PAGE_SIZE || '50', 10),
    concurrency: Number.parseInt(process.env.FORGE_INTEGRITY_CONCURRENCY || '4', 10),
    workerId: process.env.FORGE_INTEGRITY_WORKER_ID || undefined,
  });
  try {
    const command = process.argv[2] || 'scan';
    if (command === 'scan') {
      const result = await reconciler.scan({ runId: process.env.FORGE_INTEGRITY_RUN_ID || undefined, reason: process.env.FORGE_INTEGRITY_REASON || 'operator' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === 'plan') {
      if (!process.argv[3]) throw new Error('run id is required');
      const plan = await reconciler.buildRepairPlan(process.argv[3]);
      console.log(JSON.stringify({ runId: process.argv[3], generatedAt: new Date().toISOString(), checksum: checksum(plan), plan }, null, 2));
      return;
    }
    if (command === 'apply') {
      if (!process.argv[3]) throw new Error('plan JSON file is required');
      const fs = require('node:fs/promises');
      const document = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
      const approvedBy = process.env.FORGE_INTEGRITY_APPROVED_BY;
      const approvalToken = process.env.FORGE_INTEGRITY_APPROVAL_TOKEN;
      if (!approvedBy || !approvalToken) throw new Error('FORGE_INTEGRITY_APPROVED_BY and FORGE_INTEGRITY_APPROVAL_TOKEN are required');
      const runId = document.runId || process.env.FORGE_INTEGRITY_RUN_ID;
      if (!runId) throw new Error('plan run id is required');
      const results = [];
      for (const plan of document.plan || []) results.push(await reconciler.applyRepairPlan({ runId, plan, approvedBy, approvalToken }));
      console.log(JSON.stringify({ runId, results }, null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
