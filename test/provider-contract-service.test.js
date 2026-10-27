'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProviderContractService, normalizeContract, matchesSchema } = require('../src/providers/provider-contract-service');

test('provider contract normalization is deterministic and rejects malformed contracts', () => {
  const contract = normalizeContract({ provider:'acme', capability:'image-generation', contractVersion:'2026-10-27.1', operations:['generate','generate'], models:['m2','m1'], inputSchema:{type:'object',required:['prompt'],properties:{prompt:{type:'string'}},additionalProperties:false} });
  assert.deepEqual(contract.operations, ['generate']);
  assert.deepEqual(contract.models, ['m1','m2']);
  assert.equal(contract.schemaVersion, 1);
  assert.throws(() => normalizeContract({ provider:'acme', capability:'image-generation' }));
});

test('schema enforcement fails closed on unknown fields and invalid types', () => {
  const schema={type:'object',required:['prompt'],properties:{prompt:{type:'string'}},additionalProperties:false};
  assert.deepEqual(matchesSchema({prompt:'ok'},schema),[]);
  assert.ok(matchesSchema({prompt:'ok',secret:'unexpected'},schema).some(e=>e.includes('unknown field')));
  assert.ok(matchesSchema({prompt:42},schema).some(e=>e.includes('expected string')));
});

test('migration ordering remains monotonic and provider contract migration is last', () => {
  const dir=path.join(__dirname,'..','migrations');
  const files=fs.readdirSync(dir).filter(name=>/^\d+_.+\.sql$/.test(name)).sort((a,b)=>Number(a.match(/^\d+/)[0])-Number(b.match(/^\d+/)[0]));
  const nums=files.map(name=>Number(name.match(/^\d+/)[0]));
  for(let i=1;i<nums.length;i+=1) assert.ok(nums[i]>nums[i-1],`migration ordering violation: ${files[i-1]} -> ${files[i]}`);
  assert.equal(files.at(-1),'114_provider_contract_verification.sql');
});

test('startup verification is fail-closed when the contract store is unavailable', async () => {
  const pool={query:async()=>{throw new Error('database unavailable')}};
  const service=new ProviderContractService({pool,signingSecret:'test-secret'});
  await assert.rejects(() => service.startupValidate(), /database unavailable/);
});

test('postgres contract regression/concurrency suite runs when DATABASE_URL is provided', {skip:!process.env.DATABASE_URL}, async () => {
  const { Pool }=require('pg');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4});
  const service=new ProviderContractService({pool,signingSecret:process.env.FORGE_PROVIDER_CONTRACT_SIGNING_SECRET||'test-secret'});
  await pool.query('SELECT 1');
  const base={provider:'test-concurrency',capability:'text-generation',contractVersion:`test-${Date.now()}`,operations:['generate'],models:['test-v1'],inputSchema:{type:'object',required:['prompt'],properties:{prompt:{type:'string'}},additionalProperties:false},outputSchema:{type:'object'},limits:{maxOutputBytes:1024},idempotency:'IDEMPOTENT'};
  const rows=await Promise.all(Array.from({length:8},()=>service.upsert({contract:base,actor:'test'})));
  assert.ok(rows.every(row=>row.contract_hash===rows[0].contract_hash));
  const state=await service.state(base.provider,base.capability); assert.equal(state,null);
  await pool.query('DELETE FROM forge_provider_contracts WHERE provider=$1',[base.provider]);
  await pool.end();
});
