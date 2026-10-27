'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SecretCipher } = require('../src/runtime/runtime-policy');
const { credentialHeaders, } = require('../src/pipeline/http-provider');
const { confirmToken, safeJson } = require('../src/providers/credential-registry');

function key() { return Buffer.alloc(32, 7).toString('base64'); }

test('credential encryption round trips without exposing plaintext in ciphertext', () => {
  const cipher = new SecretCipher(key());
  const plaintext = JSON.stringify({ apiKey: 'super-secret-provider-key', refreshToken: 'refresh-secret' });
  const encrypted = cipher.encrypt(plaintext);
  assert.notEqual(encrypted.ciphertext.toString('utf8'), plaintext);
  assert.equal(cipher.decrypt(encrypted), plaintext);
});

test('secret redaction removes sensitive nested fields', () => {
  const safe = safeJson({ provider: 'openai', authorization: 'Bearer secret', nested: { apiKey: 'abc', visible: 'ok' } });
  assert.equal(safe.authorization, '[REDACTED]');
  assert.equal(safe.nested.apiKey, '[REDACTED]');
  assert.equal(safe.nested.visible, 'ok');
});

test('provider adapter maps encrypted credential material only at execution boundary', () => {
  assert.deepEqual(credentialHeaders({ apiKey: 'secret-value' }), { authorization: 'Bearer secret-value' });
  assert.deepEqual(credentialHeaders({ headers: { 'x-provider-key': 'secret-value' } }), { 'x-provider-key': 'secret-value' });
});

test('confirmation tokens are fenced to credential version', () => {
  const a = confirmToken({ action: 'ROTATE', credentialId: 'cred-1', version: 1 });
  const b = confirmToken({ action: 'ROTATE', credentialId: 'cred-1', version: 2 });
  assert.notEqual(a, b);
});

if (process.env.FORGE_CREDENTIAL_INTEGRATION === 'true') {
  test('PostgreSQL credential lifecycle, tenant isolation and concurrent rotation', async () => {
    const { Pool } = require('pg');
    const { ProviderCredentialRegistry } = require('../src/providers/credential-registry');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    const registry = new ProviderCredentialRegistry({ pool, secretCipher: new SecretCipher(key()) });
    const tenantA = `credential-test-a-${Date.now()}`;
    const tenantB = `credential-test-b-${Date.now()}`;
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'credential-test'),($3,$4,'credential-test')", [tenantA, 'credential-test-a', tenantB, 'credential-test-b']);
    try {
      await registry.upsertCapability({ provider: 'test-provider', capability: 'text-generation', model: 'test-model', actor: 'credential-test' });
      const created = await registry.create({ tenantId: tenantA, provider: 'test-provider', credentialName: 'default', material: { apiKey: 'tenant-a-secret' }, capabilities: [{ capability: 'text-generation', model: 'test-model' }], actor: 'credential-test' });
      await assert.rejects(() => registry.get({ tenantId: tenantB, credentialId: created.id }), /credential not found/);
      const lease = await registry.selectAndLease({ tenantId: tenantA, provider: 'test-provider', credentialName: 'default', capability: 'text-generation', model: 'test-model', resourceType: 'job', resourceId: 'credential-test-job', leaseSeconds: 60 });
      assert.equal(lease.version, 1);
      assert.equal(lease.material.apiKey, 'tenant-a-secret');
      const confirmation = confirmToken({ action: 'ROTATE', credentialId: created.id, version: created.version });
      const [r1, r2] = await Promise.allSettled([
        registry.rotate({ tenantId: tenantA, credentialId: created.id, material: { apiKey: 'new-secret-1' }, capabilities: [{ capability: 'text-generation', model: 'test-model' }], actor: 'credential-test', confirm: confirmation, idempotencyKey: 'rotation-1', overlapSeconds: 30 }),
        registry.rotate({ tenantId: tenantA, credentialId: created.id, material: { apiKey: 'new-secret-2' }, capabilities: [{ capability: 'text-generation', model: 'test-model' }], actor: 'credential-test', confirm: confirmation, idempotencyKey: 'rotation-2', overlapSeconds: 30 })
      ]);
      assert.equal([r1, r2].filter(x => x.status === 'fulfilled').length, 1);
      const next = await registry.selectAndLease({ tenantId: tenantA, provider: 'test-provider', credentialName: 'default', capability: 'text-generation', model: 'test-model', resourceType: 'job', resourceId: 'credential-test-job-2', leaseSeconds: 60 });
      assert.ok(next.version >= 2);
      assert.notEqual(next.material.apiKey, 'tenant-a-secret');
      await registry.releaseLease({ tenantId: tenantA, leaseId: lease.leaseId, resourceType: 'job', resourceId: 'credential-test-job' });
      await registry.releaseLease({ tenantId: tenantA, leaseId: next.leaseId, resourceType: 'job', resourceId: 'credential-test-job-2' });
    } finally {
      await pool.query('DELETE FROM forge_provider_credential_leases WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]);
      await pool.query('DELETE FROM forge_provider_credential_audit WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]);
      await pool.query('DELETE FROM forge_provider_credentials WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]);
      await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)', [tenantA, tenantB]);
      await pool.end();
    }
  });
}
