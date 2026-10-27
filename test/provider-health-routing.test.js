'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderHealthRouter, candidateScope, normalizePolicy } = require('../src/reliability/provider-health-routing');

const context = { tenantId: 'tenant-a', projectId: 'project-a', operation: 'script', capability: 'llm', model: 'model-a', idempotencyKey: 'job-1', idempotent: true, allowFailover: true };

test('rejects incompatible tenant, project, credential and release candidates', () => {
  assert.equal(candidateScope({ name: 'wrong-tenant', tenantId: 'tenant-b' }, context).reason, 'TENANT_MISMATCH');
  assert.equal(candidateScope({ name: 'wrong-project', tenantId: 'tenant-a', projectId: 'project-b' }, context).reason, 'PROJECT_MISMATCH');
  assert.equal(candidateScope({ name: 'wrong-credential', tenantId: 'tenant-a', credentialVersion: 2 }, { ...context, credentialVersion: 1 }).reason, 'CREDENTIAL_VERSION_MISMATCH');
  assert.equal(candidateScope({ name: 'wrong-epoch', tenantId: 'tenant-a', releaseEpoch: 'r2' }, { ...context, releaseEpoch: 'r1' }).reason, 'RELEASE_EPOCH_MISMATCH');
});

test('fails over only after an idempotent retryable provider failure', async () => {
  let firstCalls = 0; let secondCalls = 0;
  const first = { name: 'provider-a', tenantId: 'tenant-a', priority: 10, capabilities: ['llm'], models: ['model-a'], execute: async () => { firstCalls += 1; throw Object.assign(new Error('upstream unavailable'), { retryable: true, code: 'PROVIDER_UNAVAILABLE' }); } };
  const second = { name: 'provider-b', tenantId: 'tenant-a', priority: 1, capabilities: ['llm'], models: ['model-a'], execute: async () => { secondCalls += 1; return { artifacts: [{ kind: 'text', content: 'ok' }] }; } };
  const router = new ProviderHealthRouter({ policy: { maxCandidates: 2, failureThreshold: 1 } });
  const result = await router.execute({ candidates: [first, second], context, request: { prompt: 'hello' } });
  assert.equal(result.routing.provider, 'provider-b'); assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
});

test('does not fail over terminal provider errors', async () => {
  let secondCalls = 0;
  const first = { name: 'provider-a', tenantId: 'tenant-a', capabilities: ['llm'], models: ['model-a'], execute: async () => { throw Object.assign(new Error('bad input'), { retryable: false, code: 'HTTP_400' }); } };
  const second = { name: 'provider-b', tenantId: 'tenant-a', capabilities: ['llm'], models: ['model-a'], execute: async () => { secondCalls += 1; return { ok: true }; } };
  const router = new ProviderHealthRouter();
  await assert.rejects(() => router.execute({ candidates: [first, second], context, request: {} }), /bad input/); assert.equal(secondCalls, 0);
});

test('policy validation is bounded', () => { assert.throws(() => normalizePolicy({ windowSize: 0 }), /windowSize/); assert.throws(() => normalizePolicy({ failureRateThreshold: 2 }), /failureRateThreshold/); });

test('postgres health state and concurrent half-open probe tests run when enabled', { skip: !process.env.FORGE_PROVIDER_HEALTH_INTEGRATION }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const router = new ProviderHealthRouter({ pool, policy: { recoveryMs: 1, probeLeaseMs: 5000, failureThreshold: 1 } });
  const tenantId = `health-test-${Date.now()}`; await pool.query(`INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, [tenantId, tenantId]);
  const candidate = { name: `probe-${Date.now()}`, tenantId }; const c = { ...context, tenantId, projectId: null, operation: 'probe' };
  await router.state(c, candidate);
  await pool.query(`UPDATE provider_health_state SET state='OPEN',cooldown_until=now()-interval '1 second',probe_owner=NULL,probe_until=NULL WHERE tenant_id=$1 AND project_id IS NULL AND provider=$2 AND model=$3 AND operation=$4`, [tenantId, candidate.name, '', c.operation]);
  const results = await Promise.all([router.acquire(c, candidate), router.acquire(c, candidate)]); assert.equal(results.filter((r) => r.allowed).length, 1);
  await pool.query(`DELETE FROM provider_health_events WHERE tenant_id=$1`, [tenantId]); await pool.query(`DELETE FROM provider_health_state WHERE tenant_id=$1`, [tenantId]); await pool.end();
});
