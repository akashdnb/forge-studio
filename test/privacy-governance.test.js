'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivacyGovernance, redactSensitive, sanitizeRunnerManifest, fingerprint } = require('../src/privacy/privacy-governance');

function governance() {
  const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('DB not expected in unit test'); } };
  return new PrivacyGovernance({ pool, encryptionKey: Buffer.alloc(32, 7).toString('base64'), clock: () => new Date('2026-10-27T00:00:00Z') });
}

test('redacts nested sensitive payloads without changing safe values', () => {
  const input = { name: 'episode', token: 'secret-token', nested: { password: 'pw', title: 'safe' }, items: [{ apiKey: 'key', value: 4 }] };
  assert.deepEqual(redactSensitive(input), { name: 'episode', token: '[REDACTED]', nested: { password: '[REDACTED]', title: 'safe' }, items: [{ apiKey: '[REDACTED]', value: 4 }] });
  assert.equal(input.token, 'secret-token');
});

test('runner manifests exclude sensitive provider data by default', () => {
  const result = sanitizeRunnerManifest({ episodeId: 'e1', providerPayload: { token: 'x' }, authorization: 'Bearer x', title: 'safe' });
  assert.equal(result.episodeId, 'e1'); assert.equal(result.title, 'safe');
  assert.equal(result.providerPayload, undefined); assert.equal(result.authorization, '[REDACTED]');
});

test('AES-GCM quarantine encryption round-trips redacted payloads', () => {
  const g = governance(); const payload = { email: 'user@example.com', accessToken: 'do-not-store-plaintext' };
  const encrypted = g.encryptPayload(redactSensitive(payload));
  assert.notEqual(encrypted.toString('utf8'), JSON.stringify(payload));
  assert.deepEqual(g.decryptPayload(encrypted), { email: 'user@example.com', accessToken: '[REDACTED]' });
});

test('retention eligibility is deterministic and policy-snapshot based', () => {
  const g = governance();
  const snapshot = { id: 'snap-1', fingerprint: fingerprint({ version: 1 }), policy: { defaultDays: 30, graceDays: 5, domains: { event_payloads: { retentionDays: 10, graceDays: 3 } } } };
  const now = new Date('2026-10-27T00:00:00Z');
  const eligible = g.evaluate({ observedAt: '2026-10-10T00:00:00Z', domain: 'event_payloads', snapshot, now });
  assert.equal(eligible.eligible, true); assert.equal(eligible.reason, 'ELIGIBLE_FOR_APPROVAL');
  const before = g.evaluate({ observedAt: '2026-10-20T00:00:00Z', domain: 'event_payloads', snapshot, now });
  assert.equal(before.eligible, false); assert.equal(before.reason, 'RETENTION_WINDOW');
  const held = g.evaluate({ observedAt: '2026-10-10T00:00:00Z', domain: 'event_payloads', snapshot, holds: [{ id: 'h1' }], now });
  assert.equal(held.blocked, true); assert.deepEqual(held.holdIds, ['h1']);
  const immutable = g.evaluate({ observedAt: '2020-01-01T00:00:00Z', domain: 'audit_evidence', snapshot, now });
  assert.equal(immutable.preserved, true); assert.equal(immutable.reason, 'IMMUTABLE_EVIDENCE');
});

test('policy fingerprints are stable across object key ordering', () => {
  assert.equal(fingerprint({ b: 2, a: { z: 1, y: 2 } }), fingerprint({ a: { y: 2, z: 1 }, b: 2 }));
});

test('postgres retention concurrency suite is opt-in and never runs against an unknown database', async (t) => {
  if (!process.env.DATABASE_URL) { t.skip('DATABASE_URL not configured'); return; }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id LIMIT 1')).rows;
    if (!tenants[0]) { t.skip('no disposable tenant'); return; }
    const g = new PrivacyGovernance({ pool, encryptionKey: process.env.FORGE_PRIVACY_ENCRYPTION_KEY || process.env.FORGE_SECRET_ENCRYPTION_KEY });
    const tenantId = tenants[0].id;
    const results = await Promise.all([
      g.setPolicy({ tenantId, actor: 'privacy-test-a', policy: { defaultDays: 31 } }),
      g.setPolicy({ tenantId, actor: 'privacy-test-b', policy: { defaultDays: 32 } })
    ]);
    assert.equal(new Set(results.map((r) => r.version)).size, 2);
    const snapshot = await g.snapshotPolicy({ tenantId, executionKind: 'test', executionId: 'concurrency-test' });
    const [sameA, sameB] = await Promise.all([
      g.snapshotPolicy({ tenantId, executionKind: 'test', executionId: 'concurrency-test' }),
      g.snapshotPolicy({ tenantId, executionKind: 'test', executionId: 'concurrency-test' })
    ]);
    assert.equal(sameA.id, sameB.id); assert.equal(snapshot.id, sameA.id);
  } finally { await pool.end(); }
});
