const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpWorkflowHandlers, STAGES, assertProviderEndpoint } = require('../src/pipeline/http-workflow-handlers');

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

test('provider endpoints must be absolute HTTPS and cannot include embedded credentials', () => {
  assert.equal(assertProviderEndpoint('https://provider.example/generate'), 'https://provider.example/generate');
  assert.throws(() => assertProviderEndpoint('http://provider.example/generate'), /HTTPS/);
  assert.throws(() => assertProviderEndpoint('https://user:secret@provider.example/generate'), /Credentials/);
  assert.throws(() => assertProviderEndpoint('/relative'), /absolute HTTPS/);
});

test('HTTP stage provider persists normalized artifact response and records provenance edges', async () => {
  const calls = [];
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const repository = { db: {
    getEpisode: async () => ({ id: 'episode-1', projectId: 'project-1' }),
    withTransaction: async (fn) => fn({ query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id, episode_id, kind')) return { rows: [] };
      if (sql.startsWith('SELECT episode_id FROM version_records')) return { rows: [{ episode_id: 'episode-1' }] };
      return { rows: [] };
    }}),
  }};
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
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.stage, 'SCRIPT');
        return new Response(JSON.stringify({ artifact: { content: { text: 'Generated script' }, contentHash: 'abc', inputVersionIds: ['research-v1'] }, provider: 'test' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      timeoutMs: 1000,
      logger: { log() {} },
    });
    assert.equal(result.stage, 'SCRIPT');
    assert.equal(result.episodeId, 'episode-1');
    assert.ok(result.versionId);
    assert.ok(result.artifactId);
    assert.equal(calls.length, 5);
    assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO version_dependencies')).length, 1);
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_SCRIPT_ENDPOINT;
    else process.env.FORGE_STAGE_SCRIPT_ENDPOINT = old;
  }
});

test('QA provider persists a structured result for the generated QA artifact', async () => {
  const calls = [];
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const repository = { db: {
    getEpisode: async () => ({ id: 'episode-1', projectId: 'project-1' }),
    withTransaction: async (fn) => fn({ query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id, episode_id, kind')) return { rows: [] };
      return { rows: [] };
    }}),
  }};
  const old = process.env.FORGE_STAGE_QA_ENDPOINT;
  process.env.FORGE_STAGE_QA_ENDPOINT = 'https://provider.example/qa';
  try {
    const result = await executeStage({
      stage: 'qa', payload: { episodeId: 'episode-1', actor: 'actor-1' }, job: { id: 'job-qa' }, repository,
      fetchImpl: async () => new Response(JSON.stringify({ artifact: { content: { status: 'PASSED', checks: [{ id: 'duration', passed: true }] } }, provider: 'qa-test' }), { status: 200 }),
      timeoutMs: 1000, logger: { log() {} },
    });
    assert.equal(result.stage, 'QA');
    const qaInsert = calls.find((call) => call.sql.startsWith('INSERT INTO qa_results'));
    assert.ok(qaInsert);
    assert.equal(qaInsert.values[4], 'PASSED');
    assert.deepEqual(JSON.parse(qaInsert.values[5]), [{ id: 'duration', passed: true }]);
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_QA_ENDPOINT;
    else process.env.FORGE_STAGE_QA_ENDPOINT = old;
  }
});

test('QA provider failure blocks the job instead of recording a pass', async () => {
  const { executeStage } = require('../src/pipeline/http-workflow-handlers');
  const repository = { db: {
    getEpisode: async () => ({ id: 'episode-1' }),
    withTransaction: async (fn) => fn({ query: async (sql) => sql.startsWith('SELECT id, episode_id, kind') ? { rows: [] } : { rows: [] }}),
  }};
  const old = process.env.FORGE_STAGE_QA_ENDPOINT;
  process.env.FORGE_STAGE_QA_ENDPOINT = 'https://provider.example/qa';
  try {
    await assert.rejects(executeStage({
      stage: 'qa', payload: { episodeId: 'episode-1' }, repository, job: { id: 'job-qa' },
      fetchImpl: async () => new Response(JSON.stringify({ artifact: { content: { status: 'FAILED', checks: [] } } }), { status: 200 }),
      timeoutMs: 1000, logger: { log() {} },
    }), /marked the render as failed/);
  } finally {
    if (old === undefined) delete process.env.FORGE_STAGE_QA_ENDPOINT;
    else process.env.FORGE_STAGE_QA_ENDPOINT = old;
  }
});
