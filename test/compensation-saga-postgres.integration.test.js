'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {CompensationSagaService}=require('../src/recovery/compensation-saga');

const hasDb=Boolean(process.env.DATABASE_URL);

test('PostgreSQL compensation leases fence concurrent workers and reverse artifacts deterministically',{skip:!hasDb},async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4});
  const tenant=`test-saga-tenant:${Date.now()}`;const project=`test-saga-project:${Date.now()}`;const episode=`test-saga-episode:${Date.now()}`;const workflow=`test-saga-workflow:${Date.now()}`;const version=`test-saga-version:${Date.now()}`;const artifact=`test-saga-artifact:${Date.now()}`;
  try{
    const applied=(await pool.query("SELECT 1 FROM forge_schema_migrations WHERE version='114_workflow_compensation_saga.sql'")).rowCount;assert.equal(applied,1,'run npm run migrate before PostgreSQL integration tests');
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'test')",[tenant]);
    await pool.query("INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,'Saga test','test',$2)",[project,tenant]);
    await pool.query("INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,'Saga test','test')",[episode,project]);
    await pool.query("INSERT INTO episode_workflows(id,episode_id,project_id,brief,requested_stages,idempotency_key,created_by,status) VALUES($1,$2,$3,'failure test',$4::jsonb,$5,'test','RUNNING')",[workflow,episode,project,JSON.stringify(['RENDER','QA']),`test:${workflow}`]);
    await pool.query("INSERT INTO version_records(id,episode_id,kind,payload,created_by) VALUES($1,$2,'render','{}','test')",[version,episode]);
    await pool.query("INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,created_by) VALUES($1,$2,'render',$3,'{}','test')",[artifact,episode,version]);
    const saga=new CompensationSagaService({pool});
    const plan=await saga.ensurePlan({workflowId:workflow,actor:'test'});assert.equal(plan.tenant_id,tenant);
    await saga.recordForwardSideEffect({job:{id:`job:${workflow}`,attempts:1,created_by:'test',payload:{workflowId:workflow,stage:'RENDER',episodeId:episode,projectId:project,inputVersionIds:[]}},result:{artifactId:artifact,versionId:version}});
    await saga.triggerForWorkflow({workflowId:workflow,actor:'test',trigger:'FAILURE',reason:{code:'ARTIFACT_CORRUPT'}});
    const [a,b]=await Promise.all([saga.claimNext({workerId:'worker-a'}),saga.claimNext({workerId:'worker-b'})]);
    const claims=[a,b].filter(Boolean);assert.equal(claims.length,1);
    await saga.executeClaimed(claims[0],{workerId:claims[0].workerId,fencingToken:claims[0].fencingToken});
    const [next]=[await saga.claimNext({workerId:'worker-c'})];if(next)await saga.executeClaimed(next,{workerId:next.workerId,fencingToken:next.fencingToken});
    const quarantine=await pool.query('SELECT artifact_id,tenant_id,project_id FROM forge_compensation_artifact_quarantines WHERE plan_id=$1',[plan.id]);assert.equal(quarantine.rows[0].artifact_id,artifact);assert.equal(quarantine.rows[0].tenant_id,tenant);assert.equal(quarantine.rows[0].project_id,project);
    const steps=await pool.query('SELECT sequence_no,status FROM forge_compensation_steps WHERE plan_id=$1 ORDER BY sequence_no DESC',[plan.id]);assert.ok(steps.rows.some((row)=>row.status==='SUCCEEDED'));
  }finally{
    await pool.query('DELETE FROM forge_compensation_artifact_quarantines WHERE tenant_id=$1',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM forge_compensation_approvals WHERE tenant_id=$1',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM forge_compensation_side_effects WHERE tenant_id=$1',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM forge_compensation_events WHERE tenant_id=$1',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM forge_compensation_steps WHERE plan_id IN (SELECT id FROM forge_compensation_plans WHERE tenant_id=$1)',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM forge_compensation_plans WHERE tenant_id=$1',[tenant]).catch(()=>{});
    await pool.query('DELETE FROM artifacts WHERE episode_id=$1',[episode]).catch(()=>{});await pool.query('DELETE FROM version_records WHERE episode_id=$1',[episode]).catch(()=>{});await pool.query('DELETE FROM episode_workflows WHERE id=$1',[workflow]).catch(()=>{});await pool.query('DELETE FROM episodes WHERE id=$1',[episode]).catch(()=>{});await pool.query('DELETE FROM projects WHERE id=$1',[project]).catch(()=>{});await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]).catch(()=>{});await pool.end();
  }
});

test('PostgreSQL provider compensation retries transient failures and preserves idempotency',{skip:!hasDb},async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});
  const tenant=`test-saga-retry-tenant:${Date.now()}`;const project=`test-saga-retry-project:${Date.now()}`;const episode=`test-saga-retry-episode:${Date.now()}`;const workflow=`test-saga-retry-workflow:${Date.now()}`;
  const previous=process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT;process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT='https://compensator.example/script';
  try{
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,'Saga retry','test')",[tenant]);await pool.query("INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,'Saga retry','test',$2)",[project,tenant]);await pool.query("INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,'Saga retry','test')",[episode,project]);await pool.query("INSERT INTO episode_workflows(id,episode_id,project_id,brief,requested_stages,idempotency_key,created_by,status) VALUES($1,$2,$3,'retry',$4::jsonb,$5,'test','FAILED')",[workflow,episode,project,JSON.stringify(['SCRIPT']),`test:${workflow}`]);
    let attempts=0;const failing=new CompensationSagaService({pool,fetchImpl:async()=>{attempts++;return{ok:false,status:503}}});await failing.ensurePlan({workflowId:workflow,actor:'test'});await failing.recordForwardSideEffect({job:{id:`job:${workflow}`,attempts:1,created_by:'test',payload:{workflowId:workflow,stage:'SCRIPT',episodeId:episode,projectId:project}},result:{provider:'test'}});await failing.triggerForWorkflow({workflowId:workflow,actor:'test',trigger:'PROVIDER_FAILURE',reason:{code:'PROVIDER_TIMEOUT'}});const step=await failing.claimNext({workerId:'retry-worker'});assert.ok(step);const failed=await failing.executeClaimed(step,{workerId:'retry-worker',fencingToken:step.fencingToken});assert.equal(failed.status,'FAILED');assert.equal(attempts,1);await pool.query("UPDATE forge_compensation_steps SET available_at=now() WHERE id=$1",[step.id]);
    const succeeding=new CompensationSagaService({pool,fetchImpl:async()=>({ok:true,status:200})});const retry=await succeeding.claimNext({workerId:'retry-worker-2'});assert.ok(retry);const success=await succeeding.executeClaimed(retry,{workerId:'retry-worker-2',fencingToken:retry.fencingToken});assert.equal(success.status,'SUCCEEDED');const effects=await pool.query('SELECT count(*)::int count FROM forge_compensation_side_effects WHERE plan_id=$1',[`cplan:${workflow}`]);assert.equal(effects.rows[0].count,1);
  }finally{if(previous===undefined)delete process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT;else process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT=previous;await pool.query('DELETE FROM forge_compensation_side_effects WHERE tenant_id=$1',[tenant]).catch(()=>{});await pool.query('DELETE FROM forge_compensation_events WHERE tenant_id=$1',[tenant]).catch(()=>{});await pool.query('DELETE FROM forge_compensation_steps WHERE plan_id IN (SELECT id FROM forge_compensation_plans WHERE tenant_id=$1)',[tenant]).catch(()=>{});await pool.query('DELETE FROM forge_compensation_plans WHERE tenant_id=$1',[tenant]).catch(()=>{});await pool.query('DELETE FROM episode_workflows WHERE id=$1',[workflow]).catch(()=>{});await pool.query('DELETE FROM episodes WHERE id=$1',[episode]).catch(()=>{});await pool.query('DELETE FROM projects WHERE id=$1',[project]).catch(()=>{});await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]).catch(()=>{});await pool.end()}
});
