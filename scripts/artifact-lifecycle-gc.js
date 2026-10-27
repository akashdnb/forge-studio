'use strict';
const { Pool } = require('pg');
const { createStorageFromEnv } = require('../src/storage');
const { ProductionArtifactLifecycleControlPlane } = require('../src/storage/artifact-lifecycle-production');

function usage() {
  console.error('usage: node scripts/artifact-lifecycle-gc.js <preview|create|mark|sweep|approve|delete|reconcile|recover-leases|health> --tenant TENANT_ID [--generation ID] [--actor ACTOR]');
  process.exitCode = 2;
}
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
async function main() {
  const command = process.argv[2]; const tenantId = arg('--tenant'); const generationId = arg('--generation'); const actor = arg('--actor') || process.env.FORGE_OPERATOR_ID || 'operator';
  if (!command || !tenantId) return usage();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const service = new ProductionArtifactLifecycleControlPlane({ pool, storage: createStorageFromEnv() });
  try {
    let result;
    if (command === 'preview') result = await service.preview({ tenantId, actor });
    else if (command === 'create') result = await service.createGeneration({ tenantId, actor, mode: 'ENFORCE' });
    else if (command === 'mark') result = await service.markGeneration({ tenantId, generationId, actor });
    else if (command === 'sweep') result = await service.sweepGeneration({ tenantId, generationId, actor });
    else if (command === 'approve') result = await service.approveGeneration({ tenantId, generationId, actor });
    else if (command === 'delete') result = await service.executeApprovedDeletes({ tenantId, generationId, actor, maxDeletes: Number(arg('--max-deletes') || 25), maxDeleteBytes: Number(arg('--max-delete-bytes') || service.policy.maxDeleteBytes) });
    else if (command === 'reconcile') result = await service.reconcileProvider({ tenantId, limit: Number(arg('--limit') || 100) });
    else if (command === 'recover-leases') result = await service.recoverStaleLeases({ tenantId, limit: Number(arg('--limit') || 500) });
    else if (command === 'health') result = await service.health({ tenantId });
    else return usage();
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || 'ARTIFACT_GC_FAILED', message: error.message })); process.exitCode = 1; });
