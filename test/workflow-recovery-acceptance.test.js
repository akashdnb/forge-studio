const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { reconcileSucceededStages } = require('../src/pipeline/workflow-recovery-bootstrap');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('recovery accepts only the durable succeeded attempt after a lease-expiry restart', async () => {
  const oldChecksum = checksum('attempt-1-artifact');
  const winningChecksum = checksum('attempt-2-artifact');
  const calls = [];
  const pool = {
    async query() {
      return {
        rows: [{
          workflow_id: 'wf-1',
          stage: 'RENDER',
          id: 'job-render',
          attempt: 2,
          status: 'SUCCEEDED',
          result: {
            attemptId: 'attempt-2',
            artifacts: [{ id: 'render-a2', versionId: 'render-v2', sha256: winningChecksum }],
          },
          payload: { workflowId: 'wf-1', episodeId: 'ep-1', projectId: 'p-1', stage: 'RENDER' },
        }],
      };
    },
  };
  const integration = {
    pool,
    async handleJobSuccess(job, result) {
      calls.push({ attemptId: result.attemptId, checksum: result.artifacts[0].sha256, jobAttempt: job.attempt });
      return { accepted: true };
    },
  };

  const recovered = await reconcileSucceededStages(integration, 'restart-worker');

  assert.equal(recovered, 1);
  assert.deepEqual(calls, [{ attemptId: 'attempt-2', checksum: winningChecksum, jobAttempt: 2 }]);
  assert.notEqual(calls[0].checksum, oldChecksum);
});

test('a stale attempt completion cannot become a second accepted output after recovery', async () => {
  const winningChecksum = checksum('attempt-2-artifact');
  const staleChecksum = checksum('attempt-1-artifact');
  let acceptedChecksum = winningChecksum;
  const stage = { status: 'SUCCEEDED', outputChecksum: winningChecksum };

  const acceptCompletion = (attemptId, artifactChecksum) => {
    if (stage.status === 'SUCCEEDED') return { duplicate: true };
    stage.status = 'SUCCEEDED';
    stage.outputChecksum = artifactChecksum;
    return { accepted: true };
  };

  assert.deepEqual(acceptCompletion('attempt-2', winningChecksum), { duplicate: true });
  assert.equal(stage.outputChecksum, acceptedChecksum);
  assert.deepEqual(acceptCompletion('attempt-1', staleChecksum), { duplicate: true });
  assert.equal(stage.outputChecksum, winningChecksum);
  assert.notEqual(stage.outputChecksum, staleChecksum);
});
