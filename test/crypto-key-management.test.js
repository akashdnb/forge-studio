const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

test('synchronous persistence cipher round-trips and authenticates tenant/project AAD', async () => {
  const rootKey = crypto.randomBytes(32).toString('base64');
  const kms = new KeyManagementService({ pool: { connect() {} }, rootKey });
  const scopedKey = crypto.randomBytes(32);
  const record = await KeyManagementService.withContext({ tenantId: 'tenant-a', projectId: 'project-a', purpose: 'provider-credential', key: scopedKey, epoch: 7 }, () => {
    const encrypted = kms.encryptSync('credential-material');
    assert.equal(typeof encrypted.then, 'undefined');
    return encrypted;
  });
  await assert.rejects(() => KeyManagementService.withContext({ tenantId: 'tenant-b', projectId: 'project-a', purpose: 'provider-credential', key: scopedKey, epoch: 7 }, () => kms.decryptSync(record)), /CIPHERTEXT_INVALID/);
  const plaintext = await KeyManagementService.withContext({ tenantId: 'tenant-a', projectId: 'project-a', purpose: 'provider-credential', key: scopedKey, epoch: 7 }, () => kms.decryptSync(record));
  assert.equal(plaintext, 'credential-material');
});
