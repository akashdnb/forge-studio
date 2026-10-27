const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, sha256, generateContract, compareContracts } = require('../src/api/client-contracts');

test('canonicalize is stable regardless of object insertion order', () => {
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
  assert.deepEqual(canonicalize({ z: { b: 1, a: 2 }, a: 3 }), { a: 3, z: { a: 2, b: 1 } });
});

test('contract generation sorts routes and records auth/tenant/deprecation metadata', () => {
  const document = {
    openapi: '3.0.3', info: { title: 'test', version: '1' }, security: [{ bearerAuth: [] }], paths: {
      '/v2/z': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'] } } } }, responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/v2/a': { get: { deprecated: true, 'x-sunsetAt': '2030-01-01T00:00:00Z', security: [], responses: { '200': { description: 'ok' } } } },
    }
  };
  const generated = generateContract({ document, apiVersion: '2' });
  assert.deepEqual(generated.routes.map((route) => route.routeIdentity), ['GET /v2/a', 'POST /v2/z']);
  assert.equal(generated.routes[0].authScope, 'public');
  assert.equal(generated.routes[0].tenantRequired, true);
  assert.equal(generated.routes[0].deprecated, true);
  assert.equal(generated.routes[1].requestSchema.required[0], 'name');
});

test('generation is reproducible', () => {
  const document = { openapi: '3.0.3', paths: { '/v2/b': { get: { responses: { '200': { description: 'ok' } } } }, '/v2/a': { get: { responses: { '200': { description: 'ok' } } } } } };
  const first = generateContract({ document, apiVersion: '2' });
  const second = generateContract({ document: JSON.parse(JSON.stringify(document)), apiVersion: '2' });
  assert.equal(first.contractFingerprint, second.contractFingerprint);
  assert.equal(first.compatibilityFingerprint, second.compatibilityFingerprint);
});

test('compatibility detects removed routes, schema changes and security changes', () => {
  const oldContract = generateContract({ apiVersion: '2', document: { openapi: '3.0.3', paths: { '/v2/items': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '201': { description: 'ok' } } } } } } });
  const changed = generateContract({ apiVersion: '2', document: { openapi: '3.0.3', paths: { '/v2/items': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['id'] } } } }, security: [], responses: { '201': { description: 'ok' } } } } } } });
  const result = compareContracts(oldContract, changed);
  assert.equal(result.breaking, true);
  assert.ok(result.changes.some((change) => change.type === 'request-schema-changed'));
  assert.ok(result.changes.some((change) => change.type === 'security-contract-changed'));
});

test('additive route is non-breaking', () => {
  const oldContract = generateContract({ apiVersion: '2', document: { openapi: '3.0.3', paths: { '/v2/items': { get: { responses: { '200': { description: 'ok' } } } } } } });
  const changed = generateContract({ apiVersion: '2', document: { openapi: '3.0.3', paths: { '/v2/items': { get: { responses: { '200': { description: 'ok' } } } }, '/v2/new': { get: { responses: { '200': { description: 'ok' } } } } } } });
  assert.equal(compareContracts(oldContract, changed).breaking, false);
});
