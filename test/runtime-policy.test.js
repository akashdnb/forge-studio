const test = require('node:test');
const assert = require('node:assert/strict');
const { SecretCipher, validateRuntimeConfig, evaluateFlag, rolloutBucket, redact, fingerprint } = require('../src/runtime/runtime-policy');

test('runtime config rejects invalid typed values and missing production persistence', () => {
  const result = validateRuntimeConfig({ PORT: '99999' }, { requirePersistence: true });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.key === 'PORT' && issue.code === 'INVALID_VALUE'));
  assert.ok(result.issues.some(issue => issue.key === 'DATABASE_URL' && issue.code === 'MISSING'));
});

test('runtime config accepts safe defaults and marks hot reload boundaries', () => {
  const result = validateRuntimeConfig({ DATABASE_URL: 'postgres://redacted' });
  assert.equal(result.ok, true);
  assert.equal(result.config.PORT, 8080);
  assert.equal(result.hotReloadable.FORGE_RATE_LIMIT_PER_MINUTE, true);
  assert.equal(result.hotReloadable.FORGE_AUTH_SIGNING_SECRET, false);
});

test('AES-GCM secret storage never stores plaintext and supports rotation keys', () => {
  const cipher = new SecretCipher('12345678901234567890123456789012');
  const encrypted = cipher.encrypt('super-secret-value');
  assert.notEqual(encrypted.ciphertext.toString('utf8'), 'super-secret-value');
  assert.equal(cipher.decrypt(encrypted), 'super-secret-value');
  assert.notEqual(encrypted.nonce.toString('hex'), '');
  assert.notEqual(encrypted.authTag.toString('hex'), '');
});

test('secret diagnostics redact sensitive values recursively', () => {
  const result = redact({ token: 'abc123', nested: { password: 'pw', safe: 'ok' } });
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.nested.password, '[REDACTED]');
  assert.equal(result.nested.safe, 'ok');
  assert.equal(redact({ runtime: { token: 'secret' } }).runtime.token, '[REDACTED]');
});

test('feature flags honor kill switches, explicit targets and deterministic rollout', () => {
  const base = { key: 'render.v2', enabled: true, rollout_percent: 100, kill_switch: false, targets: {} };
  assert.equal(evaluateFlag(base, { tenantId: 't1' }), true);
  assert.equal(evaluateFlag({ ...base, kill_switch: true }, { tenantId: 't1' }), false);
  assert.equal(evaluateFlag({ ...base, rollout_percent: 0, targets: { tenantIds: ['t1'] } }, { tenantId: 't1' }), true);
  const bucketA = rolloutBucket('render.v2:t1:p1:a1');
  const bucketB = rolloutBucket('render.v2:t1:p1:a1');
  assert.equal(bucketA, bucketB);
});

test('fingerprints are stable across object key ordering', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
});
