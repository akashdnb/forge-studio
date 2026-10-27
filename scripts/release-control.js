const fs=require('node:fs/promises');const path=require('node:path');const{Pool}=require('pg');const{ReleaseDeploymentController}=require('../src/release-safety/deployment-controller');const{ReleaseSafetyService}=require('../src/release-safety/release-safety');
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null}
async function manifest(){const file=arg('--manifest');if(!file)throw new Error('--manifest is required');return JSON.parse(await fs.readFile(path.resolve(file),'utf8'))}
async function main(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');const command=process.argv[2]||'preflight';const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});const service=new ReleaseDeploymentController({pool});const actor=process.env.FORGE_ACTOR_ID||'release-control';try{
 if(command==='plan'){const m=await manifest();console.log(JSON.stringify(await service.save(m,actor),null,2));return}
 if(command==='preflight'){const m=await manifest();const r=await service.check(m.releaseId,m,actor);console.log(JSON.stringify({ok:r.ok,releaseId:r.releaseId,manifestHash:r.manifest.manifest_hash||r.manifest.manifestHash,issues:r.issues,evidence:r.evidence},null,2));if(!r.ok)process.exitCode=2;return}
 const m=await manifest();
 if(command==='approve'){const qa=arg('--qa')||'cli-qa-evidence';const health=arg('--health')||'cli-health-evidence';const rollbackPlan=arg('--rollback-plan')||'cli-rollback-plan';console.log(JSON.stringify(await service.approve(m.releaseId,actor,{qa,health,rollbackPlan}),null,2));return}
 if(command==='activate'){console.log(JSON.stringify(await service.activate(m.releaseId,actor),null,2));return}
 if(command==='post-deploy'){console.log(JSON.stringify(await service.completeHealth(m.releaseId,actor),null,2));return}
 if(command==='rollback'){console.log(JSON.stringify(await service.rollback(m.releaseId,actor,{reason:arg('--reason')||'operator initiated rollback'}),null,2));return}
 if(command==='worker-check'){const legacy=new ReleaseSafetyService({pool});console.log(JSON.stringify(await legacy.workerAdmission({workerId:arg('--worker-id')||'cli-worker',releaseId:process.env.FORGE_RELEASE_ID||m.releaseId,appVersion:m.appVersion,schemaVersion:m.schemaVersion}),null,2));return}
 if(command==='flag'){const legacy=new ReleaseSafetyService({pool});const flag=arg('--flag');const enabled=arg('--enabled')==='true';const rollout=Number(arg('--rollout')||0);console.log(JSON.stringify(await legacy.setFlag(flag,{enabled,rolloutPercent:rollout,safeForRollback:arg('--safe-for-rollback')!=='false'},actor),null,2));return}
 throw new Error(`Unknown command: ${command}`)
}finally{await pool.end()}}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||'RELEASE_CONTROL_FAILED',message:e.message}));process.exitCode=1});
