const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScenePlan, normalizeScenePlan, EpisodeWorkflow, ProviderRegistry, PipelineRunner, PipelineService, MockTextProvider, MockMediaProvider, ProviderRunLedger, ArtifactRegistry } = require('../src');

function validPlan() {
  return {
    schemaVersion: '1.0',
    title: 'Plan',
    scenes: [
      { id: 's1', title: 'Opening', type: 'title-card', durationSeconds: 3, narration: 'Start here.' },
      { id: 's2', title: 'Diagram', type: 'diagram', durationSeconds: 8, visual: { layout: 'two-column' }, assetIds: ['a1'] },
    ],
  };
}

test('scene plan validates and normalizes timed scenes deterministically', () => {
  const plan = validPlan();
  const result = validateScenePlan(plan);
  assert.equal(result.valid, true);
  assert.equal(result.totalDurationSeconds, 11);
  const normalized = normalizeScenePlan(plan);
  assert.equal(normalized.scenes[0].startSeconds, 0);
  assert.equal(normalized.scenes[1].startSeconds, 3);
  assert.equal(normalized.totalDurationSeconds, 11);
});

test('scene plan validation reports duplicate IDs, invalid types, and duration overflow', () => {
  const plan = validPlan();
  plan.scenes.push({ id: 's1', title: 'Broken', type: 'teleport', durationSeconds: 5000 });
  const result = validateScenePlan(plan, { maxDurationSeconds: 100 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Duplicate/.test(e.message)));
  assert.ok(result.errors.some((e) => /type must be one of/.test(e.message)));
  assert.ok(result.errors.some((e) => /exceeds/.test(e.message)));
  assert.throws(() => normalizeScenePlan(plan), /Invalid scene plan/);
});

test('workflow enforces dependency closure and runs the ordered stages with version provenance', async () => {
  const registry = new ProviderRegistry();
  const ledger = new ProviderRunLedger();
  const artifacts = new ArtifactRegistry();
  const runner = new PipelineRunner({ providerRegistry: registry, ledger, artifactRegistry: artifacts });
  for (const capability of ['research', 'llm', 'scene-plan', 'tts', 'image', 'timeline', 'render', 'qa', 'publish']) {
    registry.register(capability, new MockTextProvider({ name: `mock-${capability}` }));
  }
  const pipeline = new PipelineService({ runner });
  const workflow = new EpisodeWorkflow({ pipelineService: pipeline });
  await assert.rejects(workflow.execute({ episodeId: 'ep', brief: {}, stages: ['SCRIPT'] }), /requires RESEARCH/);
  const result = await workflow.execute({ episodeId: 'ep', brief: { title: 'Example' }, stages: ['RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'ASSETS', 'TIMELINE', 'RENDER', 'QA', 'PUBLISH'] });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.stages.length, 9);
  assert.ok(result.stages[1].inputVersionIds.length > 0);
  assert.ok(result.artifactIds.length >= 9);
});

test('workflow validates structured scene-plan provider output before next stage', async () => {
  const registry = new ProviderRegistry();
  const ledger = new ProviderRunLedger();
  const artifacts = new ArtifactRegistry();
  const runner = new PipelineRunner({ providerRegistry: registry, ledger, artifactRegistry: artifacts });
  registry.register('research', new MockTextProvider());
  registry.register('llm', new MockTextProvider());
  registry.register('scene-plan', {
    name: 'bad-scene-plan',
    async execute(request, context) {
      return { artifacts: [{ id: 'bad-plan', versionId: 'bad-plan-v1', kind: 'scene-plan', content: { schemaVersion: '1.0', scenes: [] } }] };
    },
  });
  const pipeline = new PipelineService({ runner });
  const workflow = new EpisodeWorkflow({ pipelineService: pipeline });
  await assert.rejects(
    workflow.execute({ episodeId: 'ep', brief: { title: 'Example' }, stages: ['RESEARCH', 'SCRIPT', 'SCENE_PLAN'] }),
    /Invalid scene plan/,
  );
});
