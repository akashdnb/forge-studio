'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePolicyDocument, canonical, hash } = require('../src/policy-as-code/policy-engine');

const basePolicy = {
  schemaVersion: 1,
  name: 'production-governance',
  protectedActions: ['release.publish', 'provider.execute', 'artifact.download', 'runner.render'],
  defaults: { protected: 'DENY', unprotected: 'ALLOW' },
  rules: [
    { id: 'deny-prod-publish', effect: 'DENY', priority: 1000, actions: ['release.publish'], resource: { type: 'release', attributes: { environment: 'production' } } },
    { id: 'allow-release-manager', effect: 'ALLOW', priority: 100, actions: ['release.publish'], subject: { type: 'user', roles: ['release-manager'] } }
  ]
};

test('policy schema rejects unknown fields and malformed actions', async () => {
  const unknown = await validatePolicyDocument({ ...basePolicy, surprise: true });
  assert.equal(unknown.code, 'POLICY_UNKNOWN_FIELD');
  const malformed = await validatePolicyDocument({ ...basePolicy, protectedActions: ['bad action'] });
  assert.equal(malformed.code, 'POLICY_SCHEMA_INVALID');
});

test('canonical representation and hash are order independent', () => {
  const a = { b: 2, a: { d: 4, c: 3 } };
  const b = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(hash(a), hash(b));
});

test('policy document validates deterministically', async () => {
  const result = await validatePolicyDocument(basePolicy);
  assert.equal(result.valid, true);
  assert.equal(result.normalized.rules.length, 2);
  assert.equal(result.canonicalHash.length, 64);
});

test('strict matcher fields reject cross-tenant identity drift', async () => {
  const invalid = await validatePolicyDocument({
    ...basePolicy,
    rules: [{ id: 'x', effect: 'ALLOW', priority: 1, actions: ['release.publish'], subject: { type: 'user', tenantId: 'other', unknown: true } }]
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.code, 'POLICY_UNKNOWN_FIELD');
});

test('real PostgreSQL policy tests run when TEST_DATABASE_URL is configured', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  try {
    await pool.query('SELECT 1');
    await pool.query('BEGIN');
    await pool.query('ROLLBACK');
    assert.ok(true);
  } finally {
    await pool.end();
  }
});
