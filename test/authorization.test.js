'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roleAllows, evaluateCondition, AuthorizationService } = require('../src/security/authorization-service');

test('RBAC is monotonic and deny-by-default', () => {
  assert.equal(roleAllows('VIEWER', 'VIEWER'), true);
  assert.equal(roleAllows('VIEWER', 'EDITOR'), false);
  assert.equal(roleAllows('OWNER', 'EDITOR'), true);
  assert.equal(roleAllows('NOPE', 'VIEWER'), false);
});

test('ABAC conditions are explicit and fail closed', () => {
  assert.equal(evaluateCondition({ 'project.lifecycleState': { in: ['ACTIVE'] } }, { project: { lifecycleState: 'ACTIVE' } }), true);
  assert.equal(evaluateCondition({ 'project.lifecycleState': { in: ['ACTIVE'] } }, { project: { lifecycleState: 'DELETED' } }), false);
  assert.equal(evaluateCondition({ 'resource.owner': 'alice' }, { resource: { owner: 'bob' } }), false);
  assert.equal(evaluateCondition({ 'resource.secret': { exists: true } }, {}), false);
});

test('authorization service requires a real database', () => {
  assert.throws(() => new AuthorizationService({}), /pool is required/);
});

test('authorization service rejects unknown roles at assignment boundary', async () => {
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  const svc = new AuthorizationService({ pool });
  await assert.rejects(() => svc.assignRole({ tenantId: 't1', subjectId: 'u1', role: 'ADMIN', actor: 'owner' }), /Invalid role/);
});
