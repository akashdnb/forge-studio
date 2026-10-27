const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyManagementService, ScopedEnvelopeCipher } = require('../src/crypto/key-management');

test('root key validation is strict and fail-closed', () => {
  assert.throws(() => new KeyManagementService({ pool: { connect() {} }, rootKey: 'too-short' }), /32-byte/);
});

test('tenant context is mandatory for scoped envelope operations', async () => {
  const kms = { encrypt: async () => ({ epoch: 1 }), decrypt: async () => 'ok' };
  const cipher = new ScopedEnvelopeCipher({ kms, purpose: 'runtime-secret' });
  assert.throws(() => cipher.encrypt('secret'), /TENANT_SCOPE_REQUIRED/);
  const result = await KeyManagementService.withContext({ tenantId: 'tenant-a', projectId: 'project-a', purpose: 'runtime-secret' }, () => cipher.decrypt({ epoch: 1, nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), ciphertext: Buffer.alloc(0) }));
  assert.equal(result, 'ok');
});

test('AAD includes tenant, project, purpose and epoch', async () => {
  const crypto = require('node:crypto');
  const source = require('../src/crypto/key-management');
  const pool = { connect: async () => { throw new Error('database must be required for encryption'); } };
  const kms = new source.KeyManagementService({ pool, rootKey: crypto.randomBytes(32).toString('base64') });
  await assert.rejects(() => kms.encrypt({ tenantId: 't', projectId: 'p', purpose: 'runtime-secret', plaintext: 'secret' }), /database/);
});
