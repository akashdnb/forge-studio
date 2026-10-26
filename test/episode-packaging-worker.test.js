const assert = require('node:assert/strict');
const { test } = require('node:test');
const { executePackaging, stable, sha256 } = require('../src/packaging/worker');

function fixture({ state='APPROVED', checksum='a'.repeat(64), storageHash=checksum, qa=true, approval=true, metadataHashMatch=true, existing=null }={}) {
  const media={id:'render-1',episode_id:'ep-1',project_id:'project-1',kind:'render',version_id:'render-v1',storage_uri:'file:///media/render.mp4',content_hash:checksum,media_type:'video/mp4',metadata:{}};
  const episode={id:'ep-1',project_id:'project-1',title:'Episode One',description:'Description',state,current_render_id:'render-1',approved_render_id:'render-1',metadata:{youtube:{privacyStatus:'private',categoryId:'22'}}};
  const metadataHash=sha256(stable(episode.metadata));
  const approvalRow=approval?{id:'approval-1',target_id:'render-1',target_version_id:'render-v1',decision:'APPROVED',decided_at:'2026-10-27T00:00:00Z',evidence:metadataHashMatch?{metadataHash}: {metadataHash:'b'.repeat(64)}}:null;
  const qaRow=qa?{id:'qa-1',status:'PASSED',artifact_id:'render-1',version_id:'render-v1',checks:[{name:'container',status:'PASS'}],created_at:'2026-10-27T00:01:00Z'}:null;
  return { media,episode,approvalRow,qaRow,existing, storageHash, metadataHash, async query(sql,args){
    if(sql.includes('FROM episodes')) return {rows:[episode]};
    if(sql.includes('FROM artifacts a JOIN episodes')) return {rows:[{...media,storage_status:'READY',stored_hash:storageHash}]};
    if(sql.includes('FROM qa_results')) return {rows:qaRow?[qaRow]:[]};
    if(sql.includes('FROM approvals')) return {rows:approvalRow?[approvalRow]:[]};
    if(sql.includes('FROM episode_packages')) return {rows:existing?[existing]:[]};
    if(sql.includes('SELECT id,version_id,manifest_hash,status FROM episode_packages')) return {rows:existing?[existing]:[{id:args?.[0],version_id:args?.[2],manifest_hash:args?.[6],status:'READY'}]};
    if(sql.includes('INSERT INTO episode_packages')) return {rows:[]};
    if(sql.includes('SELECT id,version_id,content_hash FROM artifacts')) return {rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
}
function storage(bytes, expectedHash) { return { async openArtifact(){ return {stream:(async function*(){yield bytes;})()}; }, async putArtifact(input){ assert.equal(sha256(input.content),expectedHash); return {id:input.artifactId}; } }; }
const inspector=async (bytes,type)=>({container:'mp4',codec:'h264',width:1920,height:1080,pixelFormat:'yuv420p',profile:'High',durationSeconds:120,sizeBytes:bytes.length});

async function run(options={}) { const bytes=Buffer.from('valid-mp4-fixture'); const checksum=sha256(bytes); const pool=fixture({...options,checksum,storageHash:options.storageHash||checksum}); return executePackaging({pool,storage:storage(bytes),payload:{episodeId:'ep-1'},job:{created_by:'test'},mediaInspector:inspector}); }

test('happy path creates immutable canonical package', async()=>{ const result=await run(); assert.equal(result.stage,'EPISODE_PACKAGING'); assert.equal(result.idempotent,false); assert.match(result.packageArtifactId,/^episode-package:[a-f0-9]{64}$/); assert.match(result.packageVersionId,/^package:[a-f0-9]{64}$/); });
test('checksum mismatch fails closed', async()=>{ await assert.rejects(()=>run({storageHash:'b'.repeat(64)}),(e)=>e.code==='CHECKSUM_MISMATCH'); });
test('missing artifact is terminal', async()=>{ const pool=fixture(); pool.query=async(sql)=>{ if(sql.includes('FROM episodes')) return {rows:[pool.episode]}; if(sql.includes('FROM artifacts a JOIN episodes')) return {rows:[]}; throw new Error(sql); }; await assert.rejects(()=>executePackaging({pool,storage:storage(Buffer.from('x')),payload:{episodeId:'ep-1'}}),(e)=>e.code==='ARTIFACT_NOT_FOUND'); });
test('stale approval gate is rejected', async()=>{ await assert.rejects(()=>run({state:'AWAITING_APPROVAL'}),(e)=>e.code==='STALE_GATE'); });
test('provenance metadata mismatch is rejected', async()=>{ await assert.rejects(()=>run({metadataHashMatch:false}),(e)=>e.code==='STALE_GATE'); });
test('unsupported media is rejected', async()=>{ const bytes=Buffer.from('valid-mp4-fixture'); const pool=fixture(); await assert.rejects(()=>executePackaging({pool,storage:storage(bytes),payload:{episodeId:'ep-1'},mediaInspector:async()=>{const e=new Error('unsupported');e.code='MEDIA_UNSUPPORTED';throw e;}}),(e)=>e.code==='MEDIA_UNSUPPORTED'); });
test('manifest identity is deterministic for identical approved inputs', async()=>{ const a=await run(); const b=await run(); assert.equal(a.packageArtifactId,b.packageArtifactId); assert.equal(a.packageVersionId,b.packageVersionId); assert.equal(a.manifestHash,b.manifestHash); });
test('existing logical package is idempotent on retry', async()=>{ const first=await run(); const pool=fixture({existing:{id:first.packageArtifactId,version_id:first.packageVersionId,manifest_hash:first.manifestHash,status:'READY'}}); const result=await executePackaging({pool,storage:storage(Buffer.from('valid-mp4-fixture')),payload:{episodeId:'ep-1'},mediaInspector:inspector}); assert.equal(result.idempotent,true); assert.equal(result.packageArtifactId,first.packageArtifactId); });
test('cancellation stops before storage publication', async()=>{ const controller=new AbortController(); controller.abort(); let uploaded=false; const bytes=Buffer.from('valid-mp4-fixture'); const pool=fixture(); const s={async openArtifact(){return {stream:(async function*(){yield bytes;})()};},async putArtifact(){uploaded=true;}}; await assert.rejects(()=>executePackaging({pool,storage:s,payload:{episodeId:'ep-1'},signal:controller.signal,mediaInspector:inspector}),(e)=>e.code==='CANCELLED'); assert.equal(uploaded,false); });
test('timeout from media inspection remains retryable', async()=>{ const bytes=Buffer.from('valid-mp4-fixture'); const pool=fixture(); await assert.rejects(()=>executePackaging({pool,storage:storage(bytes),payload:{episodeId:'ep-1'},mediaInspector:async()=>{const e=new Error('timeout');e.code='PROVIDER_TIMEOUT';e.retryable=true;throw e;}}),(e)=>e.code==='PROVIDER_TIMEOUT'&&e.retryable===true); });
test('partial persistence is retryable and reconciliation can reuse deterministic identity', async()=>{ const bytes=Buffer.from('valid-mp4-fixture'); let insertAttempts=0; const pool=fixture(); const original=pool.query; pool.query=async(sql,args)=>{ if(sql.includes('INSERT INTO episode_packages')){insertAttempts+=1;if(insertAttempts===1){const e=new Error('db unavailable');e.code='DB_UNAVAILABLE';throw e;}} return original(sql,args); }; await assert.rejects(()=>executePackaging({pool,storage:storage(bytes),payload:{episodeId:'ep-1'},mediaInspector:inspector}),(e)=>e.retryable===true); const result=await executePackaging({pool,storage:storage(bytes),payload:{episodeId:'ep-1'},mediaInspector:inspector}); assert.equal(result.idempotent,false); });
test('publish handoff is represented by canonical package identifiers', async()=>{ const result=await run(); assert.ok(result.packageArtifactId); assert.ok(result.packageVersionId); assert.ok(result.mediaSha256); });
