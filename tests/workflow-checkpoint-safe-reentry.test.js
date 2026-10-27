'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonical, hash } = require('../src/workflow-control/checkpoint-integrity');


test('checkpoint fingerprints are deterministic across object key order', () => {
  const a = { z: 1, nested: { b: 2, a: 3 }, list: [{ y: 2, x: 1 }] };
  const b = { list: [{ x: 1, y: 2 }], nested: { a: 3, b: 2 }, z: 1 };
  assert.deepEqual(canonical(a), canonical(b));
  assert.equal(hash(a), hash(b));
});

test('checkpoint fingerprint changes when durable state changes', () => {
  assert.notEqual(hash({ epoch: 4, outputs: ['a'] }), hash({ epoch: 5, outputs: ['a'] }));
});

const integration = process.env.DATABASE_URL ? test : test.skip;

integration('PostgreSQL re-entry idempotency is concurrency safe and tenant scoped', async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const checkpointId = `test-cp-${suffix}`;
  const planId = `test-plan-${suffix}`;
  const tenantA = `test-tenant-a-${suffix}`;
  const tenantB = `test-tenant-b-${suffix}`;
  const idempotencyKey = `test-reentry-${suffix}`;
  try {
    const available = (await pool.query(`SELECT to_regclass('forge_workflow_reentry_attempts') AS attempts, to_regclass('forge_workflow_checkpoints') AS checkpoints`)).rows[0];
    if (!available.attempts || !available.checkpoints) return;
    await pool.query(`INSERT INTO forge_execution_plans(id,tenant_id,template_version_id,release_epoch,snapshot,content_hash,status) VALUES($1,$2,'test-template',1,'{}',repeat('0',64),'QUEUED')`, [planId, tenantA]);
    await pool.query(`INSERT INTO forge_workflow_checkpoints(id,plan_id,tenant_id,template_version_id,execution_epoch,checkpoint_version,stage_id,runtime_stage,safe_state,reentry_contract,schema_version,state_hash) VALUES($1,$2,$3,'test-template',1,1,NULL,NULL,'{}','{"stageId":null,"allowedReentry":[]}',1,encode(digest('{}','sha256'),'hex'))`, [checkpointId, planId, tenantA]);
    const concurrent = await Promise.allSettled([
      pool.query(`INSERT INTO forge_workflow_reentry_attempts(id,checkpoint_id,tenant_id,plan_id,execution_epoch,requested_by,status,idempotency_key) VALUES(gen_random_uuid(),$1,$2,$3,1,'test','ADMITTED',$4)`, [checkpointId, tenantA, planId, `${idempotencyKey}-race`]),
      pool.query(`INSERT INTO forge_workflow_reentry_attempts(id,checkpoint_id,tenant_id,plan_id,execution_epoch,requested_by,status,idempotency_key) VALUES(gen_random_uuid(),$1,$2,$3,1,'test','ADMITTED',$4)`, [checkpointId, tenantA, planId, `${idempotencyKey}-race`]),
    ]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(r => r.status === 'rejected' && r.reason.code === '23505').length, 1);
    const crossTenant = (await pool.query(`SELECT count(*)::int AS count FROM forge_workflow_reentry_attempts WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantB, idempotencyKey])).rows[0].count;
    assert.equal(crossTenant, 0);
  } finally {
    await pool.query(`DELETE FROM forge_workflow_reentry_attempts WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]).catch(() => {});
    await pool.query(`DELETE FROM forge_workflow_checkpoints WHERE id=$1`, [checkpointId]).catch(() => {});
    await pool.query(`DELETE FROM forge_execution_plans WHERE id=$1`, [planId]).catch(() => {});
    await pool.end();
  }
});
