#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { SCENARIOS } = require('./run-acceptance-v2');

async function bootstrapSchema(pool) {
  const exists = await pool.query("SELECT to_regclass('public.episodes') AS table_name");
  if (exists.rows[0].table_name) return;
  const result = spawnSync(process.execPath, ['scripts/canonical-schema-bootstrap.js'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`canonical schema bootstrap failed with status ${result.status}`);
  const bootstrapped = await pool.query("SELECT to_regclass('public.episodes') AS table_name");
  if (!bootstrapped.rows[0].table_name) throw new Error('canonical schema bootstrap completed without creating episodes');
}

async function seedTenant() {
  if (!process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await bootstrapSchema(pool);
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES('tenant:acceptance','Synthetic Acceptance','acceptance') ON CONFLICT(id) DO NOTHING");
  } finally { await pool.end(); }
}

(async () => {
  const requested = process.env.FORGE_ACCEPTANCE_SCENARIO || process.argv[2] || 'all';
  if (requested !== 'all' && !SCENARIOS.includes(requested)) throw new Error(`Unknown acceptance scenario: ${requested}`);
  await seedTenant();
  const names = requested === 'all' ? SCENARIOS : [requested];
  let failed = 0;
  for (const name of names) {
    const env = {
      ...process.env,
      FORGE_ACCEPTANCE_SCENARIO: name,
      FORGE_ACCEPTANCE_SEED: `${process.env.FORGE_ACCEPTANCE_SEED || 'ci'}-${name}`,
      FORGE_USAGE_PRICING_JSON: process.env.FORGE_USAGE_PRICING_JSON || JSON.stringify(['research','script','scene_plan','narration','transcription','assets','timeline','captions','render','qa','packaging','publish'].map((stage) => ({ providerType:'worker', provider:`workflow:${stage}`, operation:`workflow:${stage}`, unitType:'request', unitPrice:0.001 }))),
      FORGE_USAGE_BUDGETS_JSON: process.env.FORGE_USAGE_BUDGETS_JSON || JSON.stringify(name === 'budget-exhaustion' ? [{ scopeType:'GLOBAL', scopeId:'global', hardCostLimit:0, currency:'USD' }] : [{ scopeType:'GLOBAL', scopeId:'global', hardCostLimit:100, currency:'USD' }])
    };
    const compat = require.resolve('./canonical-migration-compat');
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require=${compat}`.trim();
    const result = spawnSync(process.execPath, ['scripts/run-acceptance-v2.js', name], { stdio: 'inherit', env });
    if (result.status !== 0) failed += 1;
  }
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
