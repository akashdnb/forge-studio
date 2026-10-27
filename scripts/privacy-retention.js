'use strict';

const { Pool } = require('pg');
const { JobQueue } = require('../src/persistence/job-queue');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  try {
    const queue = new JobQueue({ pool });
    const tenants = (await pool.query("SELECT id FROM tenants WHERE lifecycle_state <> 'DELETED' ORDER BY id")).rows;
    const day = new Date().toISOString().slice(0, 10);
    const results = [];
    for (const tenant of tenants) {
      const scan = await queue.enqueue({
        kind: 'privacy:retention-scan', payload: { tenantId: tenant.id }, priority: 40, maxAttempts: 5,
        idempotencyKey: `privacy-retention-scan:${tenant.id}:${day}`, createdBy: 'privacy-retention-scheduler'
      });
      const execute = await queue.enqueue({
        kind: 'privacy:retention-execute', payload: { tenantId: tenant.id }, priority: 45, maxAttempts: 5,
        idempotencyKey: `privacy-retention-execute:${tenant.id}:${day}`, createdBy: 'privacy-retention-scheduler', dependsOnJobId: scan.id
      });
      results.push({ tenantId: tenant.id, scanJobId: scan.id, executeJobId: execute.id });
    }
    console.log(JSON.stringify({ status: 'ok', tenants: results.length, results }));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(`Privacy retention enqueue failed: ${error.message}`); process.exitCode = 1; });
