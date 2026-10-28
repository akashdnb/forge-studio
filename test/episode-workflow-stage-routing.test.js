const test = require('node:test');
const assert = require('node:assert/strict');
const { WORKFLOW_STAGE_KINDS } = require('../src/pipeline/episode-workflow-integration');

test('TIMELINE workflow stage dispatches to the registered timeline manifest handler', () => {
  assert.equal(WORKFLOW_STAGE_KINDS.TIMELINE, 'workflow:timeline-manifest');
});
