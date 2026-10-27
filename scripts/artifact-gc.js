const { Pool } = require('pg');
const { createStorageFromEnv } = require('../src/storage');
const { ArtifactRetentionOptimizer } = require('../src/storage/artifact-retention-optimizer');

function usage() {
  console.error('Usage: node scripts/artifact-gc.js <plan|approve|compact|report> --tenant TENANT_ID [--plan PLAN_ID] [--mode DRY_RUN|ENFORCE] [--actor ACTOR]');
  process.exitCode = 2;
}
function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
async function main() {
  const action = process.argv[2];
  const tenantId = arg('--tenant');
  if (!['plan','approve','compact','report'].includes(action) || !tenantId) return usage();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  try {
    const optimizer = new ArtifactRetentionOptimizer({ pool, storage: createStorageFromEnv(), policy: process.env.FORGE_ARTIFACT_GC_POLICY_JSON ? JSON.parse(process.env.FORGE_ARTIFACT_GC_POLICY_JSON) : {} });
    let result;
    if (action === 'plan') {
      const plan = await optimizer.createPlan({ tenantId, createdBy: arg('--actor', 'operator'), mode: arg('--mode', 'DRY_RUN'), reason: arg('--reason', 'operator-cli'), scanLimit: Number(arg('--scan-limit', '100')), maxDeleteBytes: Number(arg('--max-delete-bytes', '1073741824')) });
      result = await optimizer.executePlan({ tenantId, planId: plan.id });
    } else if (action === 'approve') result = await optimizer.approvePlan({ tenantId, planId: arg('--plan'), actor: arg('--actor') });
    else if (action === 'compact') result = await optimizer.compactApprovedPlan({ tenantId, planId: arg('--plan'), maxDeletes: Number(arg('--max-deletes', '25')) });
    else result = await optimizer.report({ tenantId, planId: arg('--plan') });
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
