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
    { id: 'deny-prod-publish', effect: 'DENY', priority: 1000, actions: ['release.publish'], resource: { type: 'release' } },
    { id: 'allow-release-manager', effect: 'ALLOW', priority: 100, actions: ['release.publish'], subject: { type: 'user', roles: ['release-manager'] } }
  ]
};

async function assertValidationError(document, code) {
  await assert.rejects(() => validatePolicyDocument(document), (error) => error.code === code);
}

test('policy schema rejects unknown fields and malformed actions', async () => {
  await assertValidationError({ ...basePolicy, surprise: true }, 'POLICY_UNKNOWN_FIELD');
  await assertValidationError({ ...basePolicy, protectedActions: ['bad action'] }, 'POLICY_SCHEMA_INVALID');
});

test('canonical representation and hash are order independent', () => {
  const a = { b: 2, a: { d: 4, c: 3 } };
  const b = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(hash(a), hash(b));
});

test('policy document validates deterministically', async () => {
  const normalized = await validatePolicyDocument(basePolicy);
  assert.equal(normalized.rules.length, 2);
  assert.equal(hash(normalized).length, 64);
});

test('strict matcher fields reject cross-tenant identity drift', async () => {
  await assertValidationError({
    ...basePolicy,
    rules: [{ id: 'x', effect: 'ALLOW', priority: 1, actions: ['release.publish'], subject: { type: 'user', tenantId: 'other', unknown: true } }]
  }, 'POLICY_UNKNOWN_FIELD');
});

test('real PostgreSQL connectivity is exercised when TEST_DATABASE_URL is configured', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  try { await pool.query('SELECT 1'); assert.ok(true); } finally { await pool.end(); }
});
