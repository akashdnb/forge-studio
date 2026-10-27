const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { ReleaseSafetyService, classifyRollback } = require('../src/release-safety/release-safety');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
async function manifest() { const file = arg('--manifest'); if (!file) throw new Error('--manifest is required'); return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const command = process.argv[2] || 'preflight'; const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }); const service = new ReleaseSafetyService({ pool });
  try {
    if (command === 'preflight') { const r = await service.preflight(await manifest()); console.log(JSON.stringify({ok:r.ok,releaseId:r.manifest.releaseId,manifestHash:r.manifest.manifestHash,schemaHash:r.schema.hash,issues:r.issues,migration:{pending:r.migration.pending.map((m)=>m.name),checksumMismatches:r.migration.checksumMismatches,unsafePending:r.migration.unsafePending,duplicates:r.migration.duplicateNumbers}},null,2)); if(!r.ok)process.exitCode=2; return; }
    const m = await manifest(); const actor = process.env.FORGE_ACTOR_ID || 'release-control'; await service.saveManifest(m, actor);
    if (command === 'approve') { const r=await service.preflight(m); if(!r.ok)throw Object.assign(new Error('Preflight gate failed'),{code:'RELEASE_BLOCKED'}); console.log(JSON.stringify(await service.approve(m.releaseId,actor,{manifestHash:r.manifest.manifestHash,schemaHash:r.schema.hash}),null,2)); return; }
    if (command === 'activate') { const r=await service.preflight(m); if(!r.ok)throw Object.assign(new Error('Preflight gate failed'),{code:'RELEASE_BLOCKED'}); await service.activate(m.releaseId,actor); console.log(JSON.stringify({ok:true,releaseId:m.releaseId})); return; }
    if (command === 'post-deploy') { console.log(JSON.stringify(await service.postDeploy(m.releaseId,arg('--schema-hash')),null,2)); return; }
    if (command === 'worker-check') { console.log(JSON.stringify(await service.workerAdmission({workerId:arg('--worker-id')||'cli-worker',releaseId:process.env.FORGE_RELEASE_ID||m.releaseId,appVersion:m.appVersion,schemaVersion:m.schemaVersion}),null,2)); return; }
    if (command === 'flag') { const flag=arg('--flag'); const enabled=arg('--enabled')==='true'; const rollout=Number(arg('--rollout')||0); console.log(JSON.stringify(await service.setFlag(flag,{enabled,rolloutPercent:rollout,safeForRollback:arg('--safe-for-rollback')!=='false'},actor),null,2)); return; }
    if (command === 'rollback-classify') { const r=await service.preflight(m); console.log(JSON.stringify(classifyRollback({migrationPreflightResult:r.migration,manifest:m,schemaChanged:arg('--schema-changed')==='true'}),null,2)); return; }
    throw new Error(`Unknown command: ${command}`);
  } finally { await pool.end(); }
}
main().catch((e)=>{console.error(JSON.stringify({ok:false,code:e.code||'RELEASE_CONTROL_FAILED',message:e.message}));process.exitCode=1;});
