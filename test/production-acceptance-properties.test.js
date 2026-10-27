const test = require('node:test');
const assert = require('node:assert/strict');
const { SCENARIOS } = require('../scripts/run-acceptance-v2');

test('acceptance scenario contract is deterministic and bounded', () => {
  assert.deepEqual(SCENARIOS, ['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery']);
});
