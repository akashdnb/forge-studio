const assert = require('node:assert/strict');
const test = require('node:test');
const { WORKFLOW_STAGE_KINDS } = require('../src/pipeline/episode-workflow-integration');

test('PACKAGING workflow stage dispatches to the registered packaging handler', () => {
  assert.equal(WORKFLOW_STAGE_KINDS.PACKAGING, 'workflow:package');
  assert.equal(WORKFLOW_STAGE_KINDS.TIMELINE, 'workflow:timeline-manifest');
});
