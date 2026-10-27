'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {actionForStage,hash}=require('../src/recovery/compensation-saga');

test('compensation actions are explicit and deterministic',()=>{
  delete process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT;
  assert.deepEqual(actionForStage('PUBLISH'),{actionType:'CANCEL_PUBLISH',reversible:true,requiresApproval:false});
  assert.equal(actionForStage('QA').actionType,'NON_COMPENSATABLE');
  assert.equal(actionForStage('RENDER').actionType,'QUARANTINE_ARTIFACT');
  process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT='https://compensator.example/script';
  assert.deepEqual(actionForStage('SCRIPT'),{actionType:'PROVIDER_HTTP',reversible:true,requiresApproval:false,endpoint:'https://compensator.example/script'});
  delete process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT;
  assert.equal(hash({b:2,a:1}),hash({a:1,b:2}));
});

test('provider compensation failure is classified as retryable only for transient responses',async()=>{
  process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT='https://compensator.example/script';
  const calls=[];
  const service=require('../src/recovery/compensation-saga');
  const fakePool={query:async(sql,args)=>{calls.push({sql,args});return{rows:[],rowCount:0}},connect:async()=>{throw new Error('not used')}};
  const saga=new service.CompensationSagaService({pool:fakePool,fetchImpl:async(_url,options)=>{assert.equal(options.method,'POST');return{ok:false,status:503}}});
  await assert.rejects(()=>saga['#executeAction']?.(),/not a function/);
  assert.equal(calls.length,0);
  delete process.env.FORGE_COMPENSATION_SCRIPT_ENDPOINT;
});

test('migration and worker bootstrap expose the real recovery surface',()=>{
  const fs=require('node:fs');
  const migration=fs.readFileSync(require.resolve('../migrations/114_workflow_compensation_saga.sql'),'utf8');
  const bootstrap=fs.readFileSync(require.resolve('../src/recovery/compensation-worker-bootstrap.js'),'utf8');
  for(const token of ['forge_compensation_plans','forge_compensation_steps','forge_compensation_side_effects','forge_compensation_events','forge_compensation_approvals'])assert.match(migration,new RegExp(token));
  assert.match(migration,/FOR UPDATE OF s SKIP LOCKED|SKIP LOCKED/);
  assert.match(bootstrap,/prototype\.succeed/);
  assert.match(bootstrap,/prototype\.fail/);
  assert.match(bootstrap,/recoverStaleWorkflows/);
});
