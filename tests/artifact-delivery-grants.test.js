'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let Pool; try { ({ Pool } = require('pg')); } catch { Pool = null; }
const { parseRange } = require('../src/storage/artifact-access-gateway');
const { ArtifactDeliveryGrantService } = require('../src/storage/artifact-delivery-grants');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');

const maybe = Pool && (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) ? test : test.skip;

test('range grants reject oversized and malformed requests', () => {
  assert.deepEqual(parseRange('bytes=10-19', 100, 20), { start: 10, end: 19, length: 10 });
  assert.throws(() => parseRange('bytes=10-40', 100, 20), /exceeds/);
  assert.throws(() => parseRange('bytes=100-100', 100, 20), /not satisfiable/);
  assert.throws(() => parseRange('bytes=1-2,4-5', 100, 20), /Multiple/);
});

test('legacy signed grant tokens are tamper evident', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const service = new ArtifactDeliveryGrantService({ pool: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, legacySecret: secret });
  const payload = { v: 1, grantId: crypto.randomUUID(), artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64), tenantId: 't', projectId: 'p', actor: 'u', purpose: 'user', audience: 'browser', action: 'download', nonce: crypto.randomUUID(), keyEpoch: 0, iat: 1, nbf: 1, exp: 9999999999, maxUses: 1, maxBytes: null, rangeStart: null, rangeEnd: null };
  const token = await service._sign(payload, 0);
  assert.equal(token.split('.').length, 3);
  await assert.rejects(() => service._verify(`${token.slice(0, -1)}x`, payload, token.split('.')[2]), /invalid signed artifact token/);
});

maybe('PostgreSQL grants enforce one-time replay and revocation under concurrency', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 8 });
  const repo = new PersistentProductionRepository({ pool });
  await repo.migrate();
  const row = (await pool.query(`SELECT a.id,a.version_id,a.content_hash,e.project_id,p.tenant_id,s.size_bytes FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN storage_objects s ON s.artifact_id=a.id WHERE a.content_hash IS NOT NULL AND s.size_bytes IS NOT NULL LIMIT 1`)).rows[0];
  if (!row) { await pool.end(); return; }
  const service = new ArtifactDeliveryGrantService({ pool, legacySecret: crypto.randomBytes(32).toString('hex') });
  const actor = `delivery-test-${Date.now()}`;
  const issued = await service.issue({ artifactId: row.id, tenantId: row.tenant_id, projectId: row.project_id, actor, maxUses: 1, audience: 'browser', action: 'download' });
  const results = await Promise.allSettled([
    service.authorize({ token: issued.token, artifactId: row.id, actor, tenantId: row.tenant_id, action: 'download', audience: 'browser', requestId: 'race-a' }),
    service.authorize({ token: issued.token, artifactId: row.id, actor, tenantId: row.tenant_id, action: 'download', audience: 'browser', requestId: 'race-b' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'ACCESS_GRANT_EXHAUSTED').length, 1);
  const issued2 = await service.issue({ artifactId: row.id, tenantId: row.tenant_id, projectId: row.project_id, actor, maxUses: 2, audience: 'browser', action: 'download' });
  await service.revoke({ grantId: issued2.grantId, actor, reason: 'test' });
  await assert.rejects(() => service.authorize({ token: issued2.token, artifactId: row.id, actor, tenantId: row.tenant_id, action: 'download', audience: 'browser' }), error => error.code === 'ACCESS_GRANT_REVOKED');
  await pool.query('DELETE FROM artifact_delivery_authorization_evidence WHERE grant_id IN ($1,$2)', [issued.grantId, issued2.grantId]).catch(() => {});
  await pool.query('DELETE FROM artifact_delivery_grant_uses WHERE grant_id IN ($1,$2)', [issued.grantId, issued2.grantId]).catch(() => {});
  await pool.query('DELETE FROM artifact_delivery_grants WHERE id IN ($1,$2)', [issued.grantId, issued2.grantId]).catch(() => {});
  await pool.end();
});
