'use strict';

const { Pool } = require('pg');
const { findStaleProviderRuns, reconcileStaleProviderRun } = require('../src/generation/provider-run-reconciliation');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const staleAfterMs = Number.parseInt(process.env.FORGE_PROVIDER_RUN_STALE_AFTER_MS || String(15 * 60 * 1000), 10);
    const limit = Number.parseInt(process.env.FORGE_PROVIDER_RUN_RECONCILE_LIMIT || '25', 10);
    const candidates = await findStaleProviderRuns(pool, { staleAfterMs, limit });
    if (!candidates.length) {
      console.log(JSON.stringify({ reconciled: 0, candidates: 0 }));
      return;
    }
    const results = [];
    for (const candidate of candidates) {
      results.push(await reconcileStaleProviderRun(pool, {
        runId: candidate.id,
        staleAfterMs,
        actor: process.env.FORGE_PROVIDER_RUN_RECONCILER_ACTOR || 'provider-run-reconciler',
      }));
    }
    console.log(JSON.stringify({ candidates: candidates.length, results }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error.code || 'PROVIDER_RUN_RECONCILIATION_FAILED', message: error.message }));
  process.exitCode = 1;
});
