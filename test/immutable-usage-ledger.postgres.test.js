const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

let Pool;
try { ({ Pool } = require('pg')); } catch {}

const databaseUrl = process.env.DATABASE_URL;
const integration = Boolean(Pool && databaseUrl);
const { ImmutableUsageLedger, QuotaExceededError } = require('../src/usage/immutable-usage-ledger');

function makePricing(version, rate = 0.25) { return { version, rate }; }
async function withDb(t, fn) {
  if (!integration) { t.skip('PostgreSQL integration requires DATABASE_URL'); return; }
  const pool = new Pool({ connectionString: databaseUrl, max: 8 }); const ledger = new ImmutableUsageLedger({ pool });
  try { await fn({ pool, ledger }); } finally { await pool.end(); }
}
async function ensurePricing(pool, { version, rate }) {
  await pool.query(`INSERT INTO usage_pricing_versions(pricing_version,provider_type,provider,model,operation,unit,rate,currency,effective_at,metadata) VALUES($1,'test','test','model','generate','unit',$2,'USD',now(),'{}'::jsonb) ON CONFLICT(pricing_version) DO NOTHING`, [version, rate]);
}

test('append is idempotent and cryptographically chained', async (t) => withDb(t, async ({ pool, ledger }) => {
  const tenantId = `ledger-test-${crypto.randomUUID()}`; const pricing = makePricing(`test-${crypto.randomUUID()}`); await ensurePricing(pool, pricing);
  const input = { tenantId, projectId: 'p1', runId: 'r1', jobId: 'j1', attempt: 1, providerType: 'image', provider: 'provider-a', model: 'm1', operation: 'generate', dimension: 'image_generation', quantity: 2, unit: 'image', rate: pricing.rate, currency: 'USD', pricingVersion: pricing.version, idempotencyKey: `idem-${crypto.randomUUID()}`, source: 'test' };
  const first = await ledger.append(input); const second = await ledger.append(input);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(first.event.event_id, second.event.event_id);
  const verification = await ledger.verifyTenant(tenantId); assert.equal(verification.valid, true); assert.equal(verification.eventCount, 1);
}));

test('database rejects mutation of immutable ledger rows', async (t) => withDb(t, async ({ pool, ledger }) => {
  const tenantId = `immutable-test-${crypto.randomUUID()}`; const pricing = makePricing(`test-${crypto.randomUUID()}`); await ensurePricing(pool, pricing);
  const event = await ledger.append({ tenantId, providerType: 'tts', provider: 'provider-b', operation: 'speak', dimension: 'tts_seconds', quantity: 3, unit: 'second', rate: pricing.rate, currency: 'USD', pricingVersion: pricing.version, idempotencyKey: `idem-${crypto.randomUUID()}` });
  await assert.rejects(pool.query('UPDATE usage_ledger_events SET amount=0 WHERE event_id=$1', [event.event.event_id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM usage_ledger_events WHERE event_id=$1', [event.event.event_id]), /append-only/);
  assert.equal((await ledger.verifyTenant(tenantId)).valid, true);
}));

test('concurrent reservations serialize at the tenant quota boundary', async (t) => withDb(t, async ({ pool, ledger }) => {
  const tenantId = `quota-test-${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO usage_quota_policies(tenant_id,dimension,period,soft_limit,hard_limit,grace_quantity,enabled) VALUES($1,'video_seconds','lifetime',8,10,0,true)`, [tenantId]);
  const attempts = await Promise.allSettled([
    ledger.reserve({ tenantId, dimension: 'video_seconds', quantity: 6, idempotencyKey: `r-${crypto.randomUUID()}` }),
    ledger.reserve({ tenantId, dimension: 'video_seconds', quantity: 6, idempotencyKey: `r-${crypto.randomUUID()}` }),
  ]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((x) => x.status === 'rejected' && x.reason instanceof QuotaExceededError).length, 1);
}));

test('tenant isolation, adjustment approval, and reconciliation are auditable', async (t) => withDb(t, async ({ pool, ledger }) => {
  const tenantA = `tenant-a-${crypto.randomUUID()}`; const tenantB = `tenant-b-${crypto.randomUUID()}`; const pricing = makePricing(`test-${crypto.randomUUID()}`); await ensurePricing(pool, pricing);
  const event = await ledger.append({ tenantId: tenantA, projectId: 'project-a', providerType: 'transcription', provider: 'provider-c', operation: 'transcribe', dimension: 'transcription_seconds', quantity: 30, unit: 'second', rate: pricing.rate, currency: 'USD', pricingVersion: pricing.version, idempotencyKey: `idem-${crypto.randomUUID()}`, metadata: { externalEventId: 'ext-1' } });
  assert.equal((await ledger.inspect({ tenantId: tenantB })).length, 0);
  const adjustment = await ledger.requestAdjustment({ tenantId: tenantA, projectId: 'project-a', targetEventId: event.event.event_id, reason: 'provider refund', quantity: 30, amount: -7.5, currency: 'USD', requestedBy: 'operator-1' });
  const applied = await ledger.decideAdjustment({ adjustmentId: adjustment.adjustment_id, approve: true, actor: 'approver-1', note: 'verified provider credit' });
  assert.equal(applied.status, 'APPLIED');
  const reconciliation = await ledger.reconcile({ tenantId: tenantA, source: 'provider-c', windowStart: new Date(Date.now() - 60000), windowEnd: new Date(Date.now() + 60000), externalEvents: [{ externalEventId: 'ext-1', provider: 'provider-c', operation: 'transcribe', quantity: 30, unit: 'second', amount: 7.5, currency: 'USD' }] });
  assert.equal(reconciliation.status, 'MATCHED');
}));

test('pricing recalculation is deterministic without mutating historical events', async (t) => withDb(t, async ({ pool, ledger }) => {
  const tenantId = `reprice-test-${crypto.randomUUID()}`; const pricing = makePricing(`test-${crypto.randomUUID()}`, 0.5); await ensurePricing(pool, pricing);
  await ledger.append({ tenantId, providerType: 'storage', provider: 's3', operation: 'egress', dimension: 'egress_bytes', quantity: 10, unit: 'byte', rate: 0.5, currency: 'USD', pricingVersion: pricing.version, idempotencyKey: `idem-${crypto.randomUUID()}` });
  const result = await ledger.recalculate({ tenantId, pricingVersion: pricing.version });
  assert.equal(result.recalculatedAmount, 5); assert.equal(result.eventCount, 1); assert.equal((await ledger.verifyTenant(tenantId)).valid, true);
}));
