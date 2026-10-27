'use strict';

const { Pool } = require('pg');
const { ExecutionTraceStore } = require('../src/observability/execution-trace');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const traceId = process.argv[2] && process.argv[2].startsWith('--trace=') ? process.argv[2].slice(8) : process.argv[2];
  const correlationId = process.argv.find(x => x.startsWith('--correlation='))?.slice(14) || null;
  const projectId = process.argv.find(x => x.startsWith('--project='))?.slice(10) || null;
  if (!traceId && !correlationId) throw new Error('usage: node scripts/diagnose-run.js <traceId> [--project=<projectId>] or --correlation=<correlationId>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const store = new ExecutionTraceStore({ pool });
    const diagnostic = await store.diagnosticSnapshot({ traceId, correlationId, projectId, limit: Number.parseInt(process.env.FORGE_DIAGNOSTICS_LIMIT || '1000', 10) });
    if (!diagnostic) { console.error('No execution trace found'); process.exitCode = 2; return; }
    console.log(JSON.stringify(diagnostic, null, 2));
  } finally { await pool.end(); }
}

main().catch(error => { console.error(`Forge run diagnostics failed: ${error.message}`); process.exitCode = 1; });
