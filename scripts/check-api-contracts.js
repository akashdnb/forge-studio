const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openApiDocument } = require('../src/http-api');
const { apiVersionContract } = require('../src/api/api-versioning');

const root = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'contracts/protected-api-baseline.json'), 'utf8'));
const v2 = JSON.parse(fs.readFileSync(path.join(root, 'contracts/openapi-v2.json'), 'utf8'));

function operations(document) {
  const result = new Map();
  for (const [route, methods] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) result.set(`${method.toUpperCase()} ${route}`, operation);
    }
  }
  return result;
}

const protectedOperations = operations(v2);
for (const [key, contract] of Object.entries(baseline.protected)) {
  const operation = protectedOperations.get(key);
  assert.ok(operation, `protected OpenAPI operation missing: ${key}`);
  const statuses = Object.keys(operation.responses || {}).filter((value) => /^\d+$/.test(value)).map(Number).sort((a, b) => a - b);
  for (const status of contract.status) assert.ok(statuses.includes(status), `${key} lost protected status ${status}`);
  assert.ok(Array.isArray(v2.security) && v2.security.length > 0, `${key} must remain bearer-protected`);
}

const current = openApiDocument();
assert.equal(current.openapi, '3.0.3', 'runtime OpenAPI must remain OpenAPI 3.0.3');
assert.ok(current.paths['/v1/episodes'], 'legacy v1 episode contract disappeared');
assert.deepEqual(apiVersionContract().supported, ['v1', 'v2']);
assert.equal(apiVersionContract().current, 'v2');
assert.equal(v2.info.version, '2.0.0');
assert.ok(v2.paths['/v2/episodes'], 'v2 contract missing');

for (const header of baseline.requiredHeaders) assert.ok(typeof header === 'string' && header.length > 0);

console.log(`API contract check passed: ${protectedOperations.size} v2 operations, ${Object.keys(current.paths).length} legacy runtime operations, policy=${apiVersionContract().policyVersion}`);
