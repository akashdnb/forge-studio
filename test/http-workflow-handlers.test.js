const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpWorkflowHandlers, STAGES, assertProviderEndpoint, STAGE_DEPENDENCIES } = require('../src/pipeline/http-workflow-handlers');

test('registers handlers for all non-publish workflow stages', () => {
  const pool = { query() {}, connect() {} };
  const handlers = createHttpWorkflowHandlers({ pool, fetchImpl: async () => { throw new Error('unexpected fetch'); } });
  assert.equal(STAGES.length, 8);
  for (const stage of STAGES) assert.equal(typeof handlers['workflow:' + stage], 'function');
  assert.deepEqual(STAGE_DEPENDENCIES.qa, ['render']);
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

test('provider endpoints must be absolute HTTPS and cannot include embedded credentials', () => {
  assert.equal(assertProviderEndpoint('https://provider.example/generate'), 'https://provider.example/generate');
  assert.throws(() => assertProviderEndpoint('http://provider.example/generate'), /HTTPS/);
  assert.throws(() => assertProviderEndpoint('https://user:secret@provider.example/generate'), /Credentials/);
  assert.throws(() => assertProviderEndpoint('/relative'), /absolute HTTPS/);
});

function repositoryFixture({ upstreamRows = [], episode = { id: 'episode-1', projectId: 'project-1' } } = {}) {
  const calls = [];
  const repository = { db: {
    pool: { query: async (sql, values) => {
      calls.push({ scope: 'pool', sql, values });
      if (sql.startsWith('SELECT kind, result FROM forge_jobs')) return { rows: upstreamRows };
      return { rows: [] };
    }},
    getEpisode: async () => episode,
    withTransaction: async (fn) => fn({ query: async (sql, values) => {
      calls.push({ scope: 'tx', sql, values });
      if (sql.startsWith('SELECT id, episode_id, kind')) return { rows: [] };
      if (sql.startsWith('SELECT episode_id FROM version_records')) return { rows: [{ episode_id: 'episode-1' }] };
      return { rows: [] };
    }}),
  }};
  return { repository, calls };
}

test('HTTP stage provider persists upstream stage result references as dependency edges', async () => {
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const upstreamRows = [{ kind: 'workflow:research', result: { stage: 'RESEARCH', versionId: 'research-v1', artifactId: 'research-a1' } }];
  const { repository, calls } = repositoryFixture({ upstreamRows });
  const old = process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
  process.env.FORGE_STAGE_SCRIPT_ENDPOINT = 'https://provider.example/script';
  try {
    const result = await executeStage({
      stage: 'script', payload: { episodeId: 'episode-1', actor: 'actor-1', brief: 'Example' }, job: { id: 'job-1', attempts: 1 },
      repository,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://provider.example/script');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.deepEqual(body.payload.inputVersionIds, ['research-v1']);
        assert.equal(body.payload.upstream.research.versionId, 'research-v1');
        return new Response(JSON.stringify({ artifact: { content: { text: 'Generated script' } }, provider: 'test' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      timeoutMs: 1000, logger: { log() {} },
    });
    assert.equal(result.stage, 'SCRIPT');
    assert.deepEqual(result.inputVersionIds, ['research-v1']);
    assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO version_dependencies')).length, 1);
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
    else process.env.FORGE_STAGE_SCRIPT_ENDPOINT = old;
  }
});

test('HTTP stage fails permanently if durable upstream artifacts are missing', async () => {
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const { repository } = repositoryFixture({ upstreamRows: [] });
  const old = process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
  process.env.FORGE_STAGE_SCRIPT_ENDPOINT = 'https://provider.example/script';
  try {
    await assert.rejects(executeStage({ stage: 'script', payload: { episodeId: 'episode-1' }, repository, fetchImpl: async () => { throw new Error('should not call provider'); }, logger: { log() {} } }), (error) => error.retryable === false && /Upstream stage result missing/.test(error.message));
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
    else process.env.FORGE_STAGE_SCRIPT_ENDPOINT = old;
  }
});

test('QA provider persists a structured result and does not silently accept failure', async () => {
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const { repository, calls } = repositoryFixture({ upstreamRows: [{ kind: 'workflow:render', result: { stage: 'RENDER', versionId: 'render-v1', artifactId: 'render-a1' } }] });
  const old = process.env.FORGE_STAGE_QA_ENDPOINT;
  process.env.FORGE_STAGE_QA_ENDPOINT = 'https://provider.example/qa';
  try {
    await assert.rejects(executeStage({
      stage: 'qa', payload: { episodeId: 'episode-1', actor: 'actor-1' }, job: { id: 'job-qa' }, repository,
      fetchImpl: async () => new Response(JSON.stringify({ artifact: { content: { status: 'FAILED', checks: [{ id: 'video-readable', passed: false }] } }, provider: 'qa-test' }), { status: 200 }),
      timeoutMs: 1000, logger: { log() {} },
    }), /marked the render as failed/);
    const qaInsert = calls.find((call) => call.sql.startsWith('INSERT INTO qa_results'));
    assert.ok(qaInsert);
    assert.equal(qaInsert.values[4], 'FAILED');
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_QA_ENDPOINT;
    else process.env.FORGE_STAGE_QA_ENDPOINT = old;
  }
});
