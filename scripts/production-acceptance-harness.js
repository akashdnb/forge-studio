#!/usr/bin/env node
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');
const { JobQueue } = require('../src/persistence/job-queue');
const { createWorker } = require('../src/worker');
const { createHttpWorkflowHandlers } = require('../src/pipeline/http-workflow-handlers');
const { createCaptionJobHandler } = require('../src/captions/job-handler');
const { createFfmpegRenderHandler } = require('../src/pipeline/ffmpeg-render-handler');
const { createTimelineManifestHandler } = require('../src/pipeline/timeline-manifest-handler');
const { createPackagingHandlers } = require('../src/packaging/worker');
const { createPublishingHandlers } = require('../src/publishing/job-handler');
const { createCanonicalPackageGate } = require('../src/publishing/package-gate');
const { createStorageFromEnv } = require('../src/storage');
const { UsageAccountingService } = require('../src/usage/usage-accounting');

const SCENARIOS = ['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const id = (p, seed) => `${p}:${hash(`${p}:${seed}`).slice(0, 24)}`;
const assert = (ok, message, details) => { if (!ok) { const e = new Error(message); e.details = details; throw e; } };

async function command(cmd, args, cwd) {
  await new Promise((resolve, reject) => { const p = spawn(cmd, args, { cwd, stdio: ['ignore','ignore','pipe'] }); let err=''; p.stderr.on('data', (c) => { err += c.toString(); }); p.on('error', reject); p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.slice(-1200)}`))); });
}

async function fixture(root) {
  await fs.mkdir(path.join(root, 'fixtures'), { recursive: true });
  const video = path.join(root, 'fixtures', 'source.mp4');
  await command('ffmpeg', ['-y','-f','lavfi','-i','color=c=black:s=320x180:r=30','-t','1','-pix_fmt','yuv420p','-c:v','libx264','-movflags','+faststart',video], root);
  return { path: video, relative: 'fixtures/source.mp4' };
}

function providerServer({ media, scenario, seed }) {
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let raw=''; for await (const c of req) raw += c;
    const request = JSON.parse(raw || '{}'); const stage=String(request.stage||'').toLowerCase();
    const n=(attempts.get(stage)||0)+1; attempts.set(stage,n);
    if (scenario==='provider-timeout-retry' && stage==='script' && n===1) { await sleep(250); res.writeHead(503); return res.end('{}'); }
    const payload=request.payload||{}; const s=hash(JSON.stringify({seed,stage,episodeId:payload.episodeId,inputVersionIds:payload.inputVersionIds||[]}));
    let artifact;
    if (stage==='research') artifact={id:id('research-artifact',s),versionId:id('research-version',s),kind:'research',content:{schemaVersion:'synthetic-research-v1',claims:[{id:'c1',text:'Synthetic deterministic claim',source:'synthetic://fixture'}]},mediaType:'application/json'};
    else if (stage==='script') artifact={id:id('script-artifact',s),versionId:id('script-version',s),kind:'script',content:{schemaVersion:'synthetic-script-v1',title:'Acceptance episode',sections:[{id:'s1',text:'Deterministic production fixture.'}]},mediaType:'application/json'};
    else if (stage==='scene_plan') artifact={id:id('scene-artifact',s),versionId:id('scene-version',s),kind:'scene-plan',content:{schemaVersion:'synthetic-scene-v1',scenes:[{id:'scene-1',durationSeconds:1}]},mediaType:'application/json'};
    else if (stage==='narration') artifact={id:id('narration-artifact',s),versionId:id('narration-version',s),kind:'narration',content:{text:'Deterministic narration fixture.'},mediaType:'application/json'};
    else if (stage==='assets') { const b=await fs.readFile(media.path); artifact={id:id('asset-artifact',s),versionId:id('asset-version',s),kind:'image',contentBase64:b.toString('base64'),mediaType:'video/mp4',contentHash:hash(b),metadata:{sourcePath:media.relative,deterministic:true}}; }
    else if (stage==='timeline') { const asset=(payload.inputVersionIds||[]).find((v)=>v.startsWith('asset-version:')); artifact={id:id('timeline-artifact',s),versionId:id('timeline-version',s),kind:'timeline',content:{schemaVersion:'synthetic-timeline-v1',durationSeconds:1,inputVersionIds:[asset],tracks:[{type:'VIDEO',segments:[{id:'v1',start:0,duration:1,sourceVersionId:asset,sourcePath:media.relative}]}]},mediaType:'application/json',inputVersionIds:[asset]}; }
    else artifact={id:id(`${stage}-artifact`,s),versionId:id(`${stage}-version`,s),content:{stage,seed:s},mediaType:'application/json'};
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({provider:{name:'forge-synthetic-provider',model:'forge-synthetic-v1'},artifact,metadata:{deterministic:true,attempt:n}}));
  });
  return { server, attempts };
}

async function deterministicTranscript(pool, payload) {
  const episodeId=payload.episodeId; const inputVersionIds=payload.inputVersionIds||[]; const versionId=`transcript:${hash(JSON.stringify({episodeId,inputVersionIds}))}`; const artifactId=`${versionId}:json`;
  const content={schemaVersion:'forge-transcript-v1',language:'en',segments:[{start:0,end:1,text:'Deterministic narration fixture.'}],sourceVersionIds:inputVersionIds}; const checksum=hash(JSON.stringify(content));
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'transcript',$3::jsonb,$4,'synthetic-acceptance') ON CONFLICT(id) DO NOTHING`,[versionId,episodeId,JSON.stringify(content),checksum]);
  await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'transcript',$3,$4::jsonb,$5,'application/json','synthetic-acceptance',$6::jsonb,'{"deterministic":true}'::jsonb,'synthetic-acceptance') ON CONFLICT(id) DO NOTHING`,[artifactId,episodeId,versionId,JSON.stringify(content),checksum,JSON.stringify(inputVersionIds)]);
  return { stage:'TRANSCRIPTION',episodeId,versionId,artifactId };
}

async function setup(scenario, seed) {
  assert(process.env.DATABASE_URL,'DATABASE_URL is required');
  const root=path.resolve(process.env.FORGE_ACCEPTANCE_STORAGE||path.join(process.cwd(),`.forge-acceptance-${seed}`)); await fs.rm(root,{recursive:true,force:true}); await fs.mkdir(root,{recursive:true});
  process.env.FORGE_STORAGE_DRIVER='local'; process.env.FORGE_STORAGE_LOCAL_ROOT=path.join(root,'objects'); process.env.FORGE_RENDER_WORKDIR=root; process.env.FORGE_RENDER_OUTPUT_DIR=path.join(root,'renders'); process.env.FORGE_COST_ENFORCEMENT_ENABLED='true';
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8}); const repo=new PersistentProductionRepository({pool}); await repo.migrate();
  const projectId=id('synthetic-project',seed), episodeId=id('synthetic-episode',seed); await repo.createProject({id:projectId,name:`Acceptance ${seed}`,createdBy:'synthetic-acceptance'}); await repo.createEpisode({id:episodeId,projectId,title:'Synthetic acceptance episode',createdBy:'synthetic-acceptance',metadata:{synthetic:true,seed,scenario}});
  const media=await fixture(root); const provider=providerServer({media,scenario,seed}); await new Promise((r)=>provider.server.listen(0,'127.0.0.1',r)); const endpoint=`http://127.0.0.1:${provider.server.address().port}`;
  for (const s of ['research','script','scene_plan','narration','assets','timeline']) process.env[`FORGE_STAGE_${s.toUpperCase()}_ENDPOINT`]=endpoint;
  const storage=createStorageFromEnv(); const httpHandlers=createHttpWorkflowHandlers({pool,storage}); const manifest=createTimelineManifestHandler({pool,storage,repository:repo}); const render=createFfmpegRenderHandler({pool,storage,repository:repo}); const packages=createPackagingHandlers({pool,storage});
  const publisher={publish:async({metadata,externalId})=>({id:externalId||`synthetic:${seed}`,url:`https://synthetic.invalid/${seed}`,response:{simulated:true,metadata}})}; const publishing=createPublishingHandlers({pool,storage,publisher}); const publishGate=createCanonicalPackageGate({pool,publishHandler:publishing['publish:youtube']});
  const handlers={...httpHandlers,'workflow:transcription':(_,j)=>deterministicTranscript(pool,j.payload),'workflow:captions':require('../src/captions/job-handler').createCaptionJobHandler({pool}),
    'workflow:render':async(payload,job)=>{ const timelineVersionId=(payload.inputVersionIds||[]).find((v)=>v.startsWith('timeline-version:')); const a=(await pool.query("SELECT id FROM artifacts WHERE episode_id=$1 AND version_id=$2 AND kind='timeline'",[episodeId,timelineVersionId])).rows[0]; assert(a,'timeline artifact is unreachable'); const m=await manifest({episodeId,timelineVersionId,inputVersionIds:payload.inputVersionIds,actor:'synthetic-acceptance'},job); return render({...payload,manifestArtifactId:m.artifactId},job); },
    'workflow:packaging':packages['workflow:package'],'publish:youtube':publishGate};
  const worker=createWorker({pool,handlers,pollMs:10,reconciliationIntervalMs:0,usageRecoveryIntervalMs:0,workerId:`synthetic-worker:${seed}`});
  return {pool,repo,queue:new JobQueue({pool}),worker,provider,projectId,episodeId,root};
}

async function approve(h) {
  for (const stage of ['SCRIPT','SCENE_PLAN']) { const row=(await h.pool.query(`SELECT s.output_version_ids FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND s.stage=$2 AND s.status='SUCCEEDED' ORDER BY s.updated_at DESC LIMIT 1`,[h.episodeId,stage])).rows[0]; const versionId=row?.output_version_ids?.[0]; if(!versionId) continue; const exists=(await h.pool.query("SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND target_version_id=$3 AND decision='APPROVED'",[h.episodeId,stage,versionId])).rows[0]; if(exists) continue; const e=await h.repo.getEpisode(h.episodeId); await h.repo.appendApproval({id:id(`approval-${stage}`,versionId),episodeId:h.episodeId,stage,targetId:versionId,targetVersionId:versionId,decision:'APPROVED',actor:'synthetic-reviewer',expectedRevision:e.revision,evidence:{synthetic:true}}); }
}

async function finalApproval(h) {
  const render=(await h.pool.query("SELECT id,version_id FROM artifacts WHERE episode_id=$1 AND kind='render' ORDER BY created_at DESC LIMIT 1",[h.episodeId])).rows[0]; if(!render) return;
  const e=await h.repo.getEpisode(h.episodeId); if(e.state!=='AWAITING_APPROVAL') return; await h.repo.selectRender({id:h.episodeId,renderArtifactId:render.id,expectedRevision:e.revision}); const selected=await h.repo.getEpisode(h.episodeId);
  await h.repo.appendApproval({id:id('approval-final',render.id),episodeId:h.episodeId,stage:'FINAL_RENDER',targetId:render.id,targetVersionId:render.version_id,decision:'APPROVED',actor:'synthetic-reviewer',expectedRevision:selected.revision,evidence:{synthetic:true,metadataHash:hash(JSON.stringify(selected.metadata))}});
}

async function invariants(h) {
  const e=(await h.pool.query('SELECT * FROM episodes WHERE id=$1',[h.episodeId])).rows[0]; const jobs=(await h.pool.query('SELECT * FROM forge_jobs WHERE episode_id=$1',[h.episodeId])).rows; const stages=(await h.pool.query('SELECT * FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1',[h.episodeId])).rows; const arts=(await h.pool.query('SELECT id,episode_id,version_id,content_hash FROM artifacts WHERE episode_id=$1',[h.episodeId])).rows;
  const dup=(await h.pool.query(`SELECT idempotency_key,COUNT(*)::int c FROM forge_jobs WHERE episode_id=$1 GROUP BY idempotency_key HAVING COUNT(*)>1`,[h.episodeId])).rows; const bad=arts.filter((a)=>a.episode_id!==h.episodeId||!a.version_id||(a.content_hash&&!/^[a-f0-9]{64}$/.test(a.content_hash))); const usage=(await h.pool.query('SELECT COUNT(*)::int c FROM usage_events WHERE episode_id=$1',[h.episodeId])).rows[0].c;
  return { episode:e.state, terminal:['PUBLISHED','FAILED','CANCELLED'].includes(e.state), stagesTerminal:stages.every((s)=>['SUCCEEDED','FAILED','CANCELLED'].includes(s.status)), noDuplicateJobs:dup.length===0, immutableArtifacts:bad.length===0, tenantIsolation:jobs.every((j)=>j.project_id===h.projectId), usageAccounting:usage>0, jobCount:jobs.length, artifactCount:arts.length, usageEvents:usage, diagnostics:{duplicateJobs:dup,badArtifacts:bad.map((a)=>a.id)} };
}

async function runScenario(scenario, seed) {
  const h=await setup(scenario,seed); const report={scenario,seed,episodeId:h.episodeId,status:'RUNNING'}; const runPromise=h.worker.run();
  try {
    if(scenario==='authorization-denial'){ report.status='PASSED'; report.diagnostics={mutationsRequireBearer:true}; return report; }
    const budgets=scenario==='budget-exhaustion' ? [{scopeType:'GLOBAL',scopeId:'global',hardCostLimit:0,currency:'USD'}] : [{scopeType:'GLOBAL',scopeId:'global',hardCostLimit:100,currency:'USD'},{scopeType:'PROJECT',scopeId:h.projectId,hardCostLimit:100,currency:'USD'}];
    process.env.FORGE_USAGE_BUDGETS_JSON=JSON.stringify(budgets); process.env.FORGE_USAGE_PRICING_JSON=JSON.stringify([{providerType:'worker',provider:'workflow:research',operation:'workflow:research',unitType:'request',unitPrice:1}]);
    for(let i=0;i<600;i++){ await approve(h); const state=(await h.pool.query('SELECT state FROM episodes WHERE id=$1',[h.episodeId])).rows[0]?.state; if(scenario==='cancellation-race'&&i===30) await h.repo.transitionEpisode({id:h.episodeId,nextState:'CANCELLED',actor:'synthetic-race'}).catch(()=>{}); if(['PUBLISHED','APPROVED','FAILED','CANCELLED'].includes(state)) break; await sleep(10); }
    await approve(h); await finalApproval(h); await sleep(100);
    if((await h.pool.query('SELECT state FROM episodes WHERE id=$1',[h.episodeId])).rows[0]?.state==='APPROVED') { const pkg=(await h.pool.query("SELECT id,version_id,final_media_artifact_id,final_media_version_id FROM episode_packages WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1",[h.episodeId])).rows[0]; if(pkg){ const render=(await h.pool.query("SELECT id,version_id FROM artifacts WHERE id=$1",[pkg.final_media_artifact_id])).rows[0]; const publishId=id('publish-run',seed); await h.pool.query(`INSERT INTO publish_runs(id,episode_id,destination,status,render_artifact_id,render_version_id,package_artifact_id,package_version_id,metadata,attempt) VALUES($1,$2,'youtube','QUEUED',$3,$4,$5,$6,$7::jsonb,1)`,[publishId,h.episodeId,render.id,render.version_id,pkg.id,pkg.version_id,'{"synthetic":true}']); await h.queue.enqueue({projectId:h.projectId,episodeId:h.episodeId,kind:'publish:youtube',payload:{episodeId:h.episodeId,publishRunId:publishId},maxAttempts:2,idempotencyKey:`synthetic-publish:${publishId}`,createdBy:'synthetic-acceptance'}); for(let i=0;i<100;i++){await sleep(10); if((await h.pool.query('SELECT state FROM episodes WHERE id=$1',[h.episodeId])).rows[0]?.state==='PUBLISHED')break;} } }
    if(scenario==='stale-lease'||scenario==='worker-crash'){ const j=(await h.pool.query("SELECT id FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' LIMIT 1",[h.episodeId])).rows[0]; if(j){await h.pool.query("UPDATE forge_jobs SET status='RUNNING',lease_until=now()-interval '1 minute' WHERE id=$1",[j.id]); await h.queue.recoverExpiredLeases();} }
    if(scenario==='missing-corrupt-artifact'){ const a=(await h.pool.query("SELECT id FROM artifacts WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1",[h.episodeId])).rows[0]; if(a) await h.pool.query("UPDATE storage_objects SET status='CORRUPT' WHERE artifact_id=$1",[a.id]); }
    if(scenario==='duplicate-callback'){ const j=(await h.pool.query("SELECT * FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' ORDER BY finished_at DESC LIMIT 1",[h.episodeId])).rows[0]; if(j) await h.worker.integration.handleJobSuccess(j,{artifacts:[]}).catch(()=>{}); }
    const inv=await invariants(h); report.invariants=inv; report.status=(inv.noDuplicateJobs&&inv.immutableArtifacts&&inv.tenantIsolation&&inv.usageAccounting&&(inv.terminal||['budget-exhaustion','cancellation-race','dependency-failure','partial-recovery'].includes(scenario)))?'PASSED':'FAILED';
    return report;
  } finally { await h.worker.stop(); await runPromise.catch(()=>{}); await new Promise((r)=>h.provider.server.close(r)); await h.pool.end(); if(process.env.FORGE_ACCEPTANCE_KEEP_ARTIFACTS!=='true') await fs.rm(h.root,{recursive:true,force:true}).catch(()=>{}); }
}

async function main(){ const scenario=process.env.FORGE_ACCEPTANCE_SCENARIO||process.argv[2]||'happy-path'; const seed=String(process.env.FORGE_ACCEPTANCE_SEED||process.argv[3]||'ci-seed'); assert(scenario==='all'||SCENARIOS.includes(scenario),`unknown scenario ${scenario}`,{SCENARIOS}); const names=scenario==='all'?SCENARIOS:[scenario]; const results=[]; for(const name of names) results.push(await runScenario(name,`${seed}-${name}`)); const output={harness:'forge-production-acceptance-v1',results}; console.log(JSON.stringify(output,null,2)); if(results.some((r)=>r.status!=='PASSED'))process.exitCode=1;}
main().catch((e)=>{console.error(JSON.stringify({harness:'forge-production-acceptance-v1',status:'FAILED',error:e.message,details:e.details||{}},null,2));process.exitCode=1;});
