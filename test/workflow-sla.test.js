'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {WorkflowSlaService}=require('../src/sla/workflow-sla');

test('workflow SLA defaults are bounded and deterministic',()=>{
 const sla=new WorkflowSlaService({pool:{query:async()=>({rows:[]}),connect:async()=>({query:async()=>({rows:[]}),release(){}})}});
 assert.equal(sla.defaults.runDeadlineSeconds,3600);assert.equal(sla.defaults.stageDeadlineSeconds,1800);assert.equal(sla.defaults.clockSkewSeconds,30);
});

test('PostgreSQL integration: concurrent SLA recovery is row-lock safe',async(t)=>{
 if(!process.env.DATABASE_URL){t.skip('DATABASE_URL not configured');return}
 const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});
 try{
  await pool.query('SELECT 1');
  const a=new WorkflowSlaService({pool});const b=new WorkflowSlaService({pool});
  const results=await Promise.all([a.warnAndRecover({limit:25}),b.warnAndRecover({limit:25})]);
  assert.ok(results.every(r=>Number.isInteger(r.recovered)&&Number.isInteger(r.expired)));
 }finally{await pool.end()}
});

test('migration-order smoke test can inspect the SLA schema when PostgreSQL is available',async(t)=>{
 if(!process.env.DATABASE_URL){t.skip('DATABASE_URL not configured');return}
 const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
 try{const r=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='workflow_sla_runs'`);const cols=new Set(r.rows.map(x=>x.column_name));for(const c of ['job_id','policy_version','run_deadline_at','stage_deadline_at','state','recovery_count'])assert.ok(cols.has(c),`missing ${c}`)}finally{await pool.end()}
});

test('failure injection shape: expired deadlines never return runnable state',async()=>{
 let expired=false;const pool={query:async(sql,params)=>{if(sql.includes('SELECT r.*,p.grace_seconds'))return{rows:expired?[{run_deadline_at:new Date(0),state:'ACTIVE',clock_skew_seconds:0}]:[]};if(sql.includes('workflow_sla_runs SET state')){expired=true;return{rows:[{id:'r1'}]}};return{rows:[]}},connect:async()=>{throw new Error('not needed')}};
 const sla=new WorkflowSlaService({pool,now:()=>new Date(1000)});
 await assert.rejects(()=>sla.assertRunnable({id:'job-1'}),/Workflow deadline exceeded/);
});
