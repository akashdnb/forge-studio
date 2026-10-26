const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpWorkflowHandlers, STAGES } = require('../src/pipeline/http-workflow-handlers');

test('registers handlers for all non-publish workflow stages', () => {
  const pool = { query() {}, connect() {} };
  const handlers = createHttpWorkflowHandlers({ pool, fetchImpl: async () => { throw new Error('unexpected fetch'); } });
  assert.equal(STAGES.length, 8);
  for (const stage of STAGES) assert.equal(typeof handlers['workflow:' + stage], 'function');
});

test('stage endpoint missing is a permanent configuration failure', async () => {
  const handlers = createHttpWorkflowHandlers({ pool: { query() {}, connect() {} } });
  const old = process.env.FORGE_STAGE_RESEARCH_ENDPOINT;
  delete process.env.FORGE_STAGE_RESEARCH_ENDPOINT;
  try {
    await assert.rejects(handlers['workflow:research']({ episodeId: 'episode-1' }), (error) => error.retryable === false && /not configured/.test(error.message));
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_RESEARCH_ENDPOINT;
    else process.env.FORGE_STAGE_RESEARCH_ENDPOINT = old;
  }
});

test('HTTP stage provider persists normalized artifact response', async () => {
  const calls = [];
  const txClient = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT id, episode_id, kind')) return { rows: [] };
    return { rows: [] };
  }};
  const pool = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT * FROM episodes')) return { rows: [{ id: values[0], project_id: 'project-1', created_by: 'actor-1' }] };
      throw new Error('unexpected pool query: ' + sql);
    },
    connect: async () => ({ ...txClient, release() {} }),
  };
  const repository = { db: {
    getEpisode: async () => ({ id: 'episode-1', projectId: 'project-1' }),
    withTransaction: async (fn) => fn({ query: txClient.query }),
  }};
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const old = process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
  process.env.FORGE_STAGE_SCRIPT_ENDPOINT = 'https://provider.example/script';
  try {
    const result = await executeStage({
      stage: 'script',
      payload: { episodeId: 'episode-1', actor: 'actor-1', brief: 'Example' },
      job: { id: 'job-1', attempts: 1 },
      repository,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://provider.example/script');
        const body = JSON.parse(options.body);
        assert.equal(body.stage, 'SCRIPT');
        return new Response(JSON.stringify({ artifact: { content: { text: 'Generated script' }, contentHash: 'abc' }, provider: 'test' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      timeoutMs: 1000,
      logger: { log() {} },
    });
    assert.equal(result.stage, 'SCRIPT');
    assert.equal(result.episodeId, 'episode-1');
    assert.ok(result.versionId);
    assert.ok(result.artifactId);
    assert.equal(calls.length, 2);
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
    else process.env.FORGE_STAGE_SCRIPT_ENDPOINT = old;
  }
});
