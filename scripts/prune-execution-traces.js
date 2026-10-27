'use strict';

const { Pool } = require('pg');
const { ExecutionTraceStore } = require('../src/observability/execution-trace');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const store = new ExecutionTraceStore({ pool });
    const deleted = await store.prune();
    console.log(JSON.stringify({ deleted, retentionDays: store.retentionDays }));
  } finally { await pool.end(); }
}

main().catch(error => { console.error(`Forge execution trace retention failed: ${error.message}`); process.exitCode = 1; });
