const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry, PipelineRunner, PipelineService, MockTextProvider, MockMediaProvider, ProviderRunLedger, ArtifactRegistry } = require('../src');

function setup(options = {}) {
  const providers = new ProviderRegistry();
  const ledger = new ProviderRunLedger();
  const artifacts = new ArtifactRegistry();
  const runner = new PipelineRunner({ providerRegistry: providers, ledger, artifactRegistry: artifacts, ...options });
  return { providers, ledger, artifacts, runner };
}

test('provider pipeline executes fake provider, stores artifact provenance and emits events', async () => {
  const events = [];
  const context = setup({ onEvent: (event) => events.push(event) });
  context.providers.register('llm', new MockTextProvider());
  const result = await context.runner.runStage({
    id: 'run-1', episodeId: 'ep-1', stage: 'SCRIPT', capability: 'llm',
    providerRequest: { text: 'Explain black holes', kind: 'script' },
    inputVersionIds: ['research-v1'], idempotencyKey: 'ep-1:script:research-v1',
  });
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(result.artifacts[0].providerRunId, 'run-1');
  assert.deepEqual(result.artifacts[0].inputVersionIds, ['research-v1']);
  assert.equal(events[0].type, 'provider-run.started');
  assert.equal(events.at(-1).type, 'provider-run.succeeded');
});

test('provider pipeline reuses successful idempotent run without invoking provider twice', async () => {
  const context = setup();
  let calls = 0;
  context.providers.register('llm', { name: 'counting', async execute() { calls += 1; return { artifacts: [{ id: 'out', kind: 'script', content: { text: 'ok' } }] }; } });
  const input = { id: 'run-1', episodeId: 'ep-1', stage: 'SCRIPT', capability: 'llm', providerRequest: { text: 'hi' }, idempotencyKey: 'same' };
  await context.runner.runStage(input);
  const reused = await context.runner.runStage({ ...input, id: 'run-2' });
  assert.equal(calls, 1);
  assert.equal(reused.reused, true);
  assert.equal(reused.run.id, 'run-1');
});

test('pipeline retries retryable failures only up to configured bound', async () => {
  const context = setup({ maxAttempts: 3 });
  let calls = 0;
  context.providers.register('image', {
    name: 'flaky',
    async execute() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('temporary'), { retryable: true });
      return { artifacts: [{ id: 'image-1', kind: 'asset', content: { ok: true } }] };
    },
  });
  const result = await context.runner.runStage({
    id: 'run-image', episodeId: 'ep-1', stage: 'ASSETS', capability: 'image',
    providerRequest: {}, idempotencyKey: 'asset:input-a',
  });
  assert.equal(calls, 3);
  assert.equal(result.run.status, 'SUCCEEDED');
});

test('pipeline does not retry permanent errors and records failed run', async () => {
  const context = setup({ maxAttempts: 4 });
  let calls = 0;
  context.providers.register('render', { name: 'broken', async execute() { calls += 1; throw new Error('invalid request'); } });
  await assert.rejects(context.runner.runStage({
    id: 'run-render', episodeId: 'ep-1', stage: 'RENDER', capability: 'render',
    providerRequest: {}, idempotencyKey: 'render:v1',
  }), /Pipeline stage RENDER failed/);
  assert.equal(calls, 1);
  assert.equal(context.ledger.get('run-render').status, 'FAILED');
});

test('pipeline rejects missing provider and invalid stage', async () => {
  const context = setup();
  await assert.rejects(context.runner.runStage({
    id: 'run', episodeId: 'ep', stage: 'INVALID', capability: 'x',
    providerRequest: {}, idempotencyKey: 'x',
  }), /Unknown pipeline stage/);
  await assert.rejects(context.runner.runStage({
    id: 'run', episodeId: 'ep', stage: 'SCRIPT', capability: 'unconfigured',
    providerRequest: {}, idempotencyKey: 'x',
  }), /No provider configured/);
});

test('PipelineService deterministically derives a stage idempotency key', async () => {
  const context = setup();
  context.providers.register('llm', new MockTextProvider());
  const pipeline = new PipelineService({ runner: context.runner });
  const first = await pipeline.run({ episodeId: 'ep-1', stage: 'SCRIPT', request: { text: 'same' }, inputVersionIds: ['brief-v1'] });
  const second = await pipeline.run({ episodeId: 'ep-1', stage: 'SCRIPT', request: { text: 'same' }, inputVersionIds: ['brief-v1'] });
  assert.equal(first.run.id, second.run.id);
  assert.equal(second.reused, true);
});

test('timeout aborts waiting on a provider and fails the logical run', async () => {
  const context = setup({ timeoutMs: 5, maxAttempts: 1 });
  context.providers.register('tts', { name: 'slow', async execute() { await new Promise((resolve) => setTimeout(resolve, 50)); return { artifacts: [] }; } });
  await assert.rejects(context.runner.runStage({
    id: 'run-slow', episodeId: 'ep-1', stage: 'NARRATION', capability: 'tts',
    providerRequest: {}, idempotencyKey: 'slow:1',
  }), /timed out/);
  assert.equal(context.ledger.get('run-slow').status, 'FAILED');
});
