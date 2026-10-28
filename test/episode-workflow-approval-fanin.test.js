const assert = require('node:assert/strict');
const test = require('node:test');
const { EpisodeWorkflowIntegration } = require('../src/pipeline/episode-workflow-integration');

function createPool({ approvals = [] } = {}) {
  const stageRows = new Map([
    ['SCENE_PLAN', { stage: 'SCENE_PLAN', status: 'SUCCEEDED', job_id: 'job-scene', output_version_ids: ['scene-v1'] }],
    ['NARRATION', { stage: 'NARRATION', status: 'SUCCEEDED', job_id: 'job-narration', output_version_ids: ['narration-v1'] }],
    ['TRANSCRIPTION', { stage: 'TRANSCRIPTION', status: 'SUCCEEDED', job_id: 'job-transcription', output_version_ids: ['transcription-v1'] }],
    ['ASSETS', { stage: 'ASSETS', status: 'SUCCEEDED', job_id: 'job-assets', output_version_ids: ['asset-v1'] }],
    ['TIMELINE', { stage: 'TIMELINE', status: 'BLOCKED', job_id: null, output_version_ids: [] }],
  ]);
  const jobs = [];
  const approvalSet = new Set(approvals);
  const pool = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT * FROM episode_workflows WHERE id=')) return { rows: [{ id: 'wf-1', episode_id: 'ep-1', project_id: 'p-1', brief: 'episode', requested_stages: ['SCENE_PLAN', 'NARRATION', 'TRANSCRIPTION', 'ASSETS', 'TIMELINE'], status: 'RUNNING' }], rowCount: 1 };
      if (normalized.startsWith('SELECT * FROM episode_workflow_stages WHERE workflow_id=')) return { rows: [...stageRows.values()], rowCount: stageRows.size };
      if (normalized.startsWith('SELECT COUNT(DISTINCT target_version_id)')) {
        const inputIds = [...new Set(params[2])];
        const approvedCount = inputIds.filter((id) => approvalSet.has(`${params[1]}:${id}`)).length;
        return approvedCount === inputIds.length ? { rows: [{ approved_count: approvedCount }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('UPDATE episode_workflow_stages SET status=')) {
        const row = stageRows.get(params[3]);
        if (!row || row.status !== 'BLOCKED') return { rows: [], rowCount: 0 };
        row.status = 'QUEUED'; row.job_id = params[0]; row.input_version_ids = JSON.parse(params[1]);
        return { rows: [row], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT state FROM episodes WHERE id=')) return { rows: [{ state: 'DRAFT' }], rowCount: 1 };
      if (normalized.startsWith('UPDATE episode_workflows SET status=')) return { rows: [], rowCount: 0 };
      if (normalized.startsWith('INSERT INTO audit_events')) return { rows: [], rowCount: 1 };
      throw new Error(`Unhandled fake SQL: ${normalized}`);
    },
    connect: async () => ({ query: (...args) => pool.query(...args), release() {} }),
  };
  return { pool, jobs, stageRows };
}

function createQueue(jobs) {
  return {
    async enqueue(input) {
      const job = { id: `job-${jobs.length + 1}`, ...input };
      jobs.push(job);
      return job;
    },
  };
}

test('TIMELINE rejects partial approval coverage across fan-in inputs', async () => {
  const { pool, jobs, stageRows } = createPool({ approvals: [
    'SCRIPT:scene-v1', 'SCRIPT:narration-v1', 'SCRIPT:transcription-v1', 'SCRIPT:asset-v1',
    'SCENE_PLAN:scene-v1', 'SCENE_PLAN:narration-v1', 'SCENE_PLAN:transcription-v1',
  ] });
  const integration = new EpisodeWorkflowIntegration({ pool, queue: createQueue(jobs) });

  await assert.rejects(() => integration.dispatchReady('wf-1', 'test'), (error) => error.code === 'APPROVAL_BLOCKED');
  assert.equal(stageRows.get('TIMELINE').status, 'BLOCKED');
  assert.equal(jobs.length, 0);
});

test('TIMELINE dispatches only when every fan-in input is approved and uses manifest routing', async () => {
  const versions = ['scene-v1', 'narration-v1', 'transcription-v1', 'asset-v1'];
  const approvals = ['SCRIPT', 'SCENE_PLAN'].flatMap((stage) => versions.map((id) => `${stage}:${id}`));
  const { pool, jobs, stageRows } = createPool({ approvals });
  const integration = new EpisodeWorkflowIntegration({ pool, queue: createQueue(jobs) });

  const dispatched = await integration.dispatchReady('wf-1', 'test');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, 'workflow:timeline-manifest');
  assert.deepEqual(dispatched[0].payload.inputVersionIds.sort(), versions.sort());
  assert.equal(stageRows.get('TIMELINE').status, 'QUEUED');
});
