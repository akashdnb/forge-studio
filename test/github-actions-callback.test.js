const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenMatches } = require('../src/execution/github-actions-callback');
test('runner callback token comparison is exact and timing-safe compatible', () => { assert.equal(tokenMatches('runner-secret', 'runner-secret'), true); assert.equal(tokenMatches('runner-secret', 'runner-secret-x'), false); assert.equal(tokenMatches('runner-secret', undefined), false); assert.equal(tokenMatches('', 'runner-secret'), false); });
