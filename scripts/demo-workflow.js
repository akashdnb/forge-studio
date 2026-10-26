#!/usr/bin/env node
const crypto = require('node:crypto');
const { ProductionService, ProviderRegistry, PipelineRunner, PipelineService, MockTextProvider, MockMediaProvider, EpisodeWorkflow, validateScenePlan, createShortsHandoff } = require('../src');

function id(prefix) { return `${prefix}-${crypto.randomUUID().slice(0, 8)}`; }

function makeScenePlan(title) {
  return {
    schemaVersion: '1.0',
    title,
    scenes: [
      { id: 'scene-1', title: 'The hook', type: 'title-card', durationSeconds: 4, narration: 'Something powerful is happening beneath the surface.', visual: { treatment: 'high-contrast-title' } },
      { id: 'scene-2', title: 'The mechanism', type: 'diagram', durationSeconds: 12, narration: 'Pressure builds as molten rock and gases move upward.', visual: { treatment: 'simple-cutaway-diagram' } },
      { id: 'scene-3', title: 'The result', type: 'animation', durationSeconds: 8, narration: 'When the pressure exceeds the rock strength, the volcano erupts.', visual: { treatment: 'layered-eruption-sequence' } },
    ],
  };
}

async function main() {
  const title = process.argv.slice(2).join(' ').trim() || 'Why volcanoes erupt';
  const production = new ProductionService();
  production.episodes.create({ id: 'demo-episode', projectId: 'demo-project', title, createdBy: 'demo', metadata: { demo: true } });

  const registry = new ProviderRegistry();
  const textProvider = new MockTextProvider();
  const mediaProvider = new MockMediaProvider();
  const scenePlanProvider = {
    name: 'mock-scene-planner',
    async execute(request, context) {
      const plan = makeScenePlan(title);
      const validation = validateScenePlan(plan);
      if (!validation.valid) throw new Error(`Mock generated invalid scene plan: ${JSON.stringify(validation.errors)}`);
      return { artifacts: [{ id: `${context.runId}-scene-plan`, versionId: `${context.runId}-v1`, kind: 'scene-plan', content: plan, mediaType: 'application/json' }], usage: { scenes: plan.scenes.length }, estimatedCost: 0, actualCost: 0 };
    },
  };
  registry.register('research', textProvider);
  registry.register('llm', textProvider);
  registry.register('scene-plan', scenePlanProvider);
  registry.register('tts', mediaProvider);
  registry.register('image', mediaProvider);
  registry.register('timeline', mediaProvider);
  registry.register('render', mediaProvider);
  registry.register('qa', {
    name: 'mock-qa',
    async execute(request, context) {
      const renderArtifact = request.render?.[0];
      return { artifacts: [{ id: `${context.runId}-qa`, kind: 'qa', versionId: `${context.runId}-v1`, content: { status: 'WARNINGS', checks: [{ name: 'provider-is-mock', status: 'WARN', message: 'Replace placeholder render with a real media renderer before publication.' }], renderArtifactId: renderArtifact?.id || null }, mediaType: 'application/json' }], usage: { checks: 1 }, estimatedCost: 0, actualCost: 0 };
    },
  });
  registry.register('publish', {
    name: 'mock-publish',
    async execute(request, context) {
      return { artifacts: [{ id: `${context.runId}-publish-record`, kind: 'publish-record', versionId: `${context.runId}-v1`, content: { dryRun: true, target: 'not-configured', source: request } }], usage: { publications: 0 }, estimatedCost: 0, actualCost: 0 };
    },
  });

  const runner = new PipelineRunner({
    providerRegistry: registry, ledger: production.providerRuns, artifactRegistry: production.artifacts,
    maxAttempts: 2, timeoutMs: 5000,
    onEvent: (event) => process.stdout.write(`[pipeline] ${JSON.stringify(event)}\n`),
  });
  const pipeline = new PipelineService({ runner });
  const workflow = new EpisodeWorkflow({ pipelineService: pipeline, maxStageCost: 0.01 });

  // Keep the demonstration safe: "PUBLISH" is a simulated provider with no external side effect.
  const results = await workflow.execute({
    episodeId: 'demo-episode',
    brief: { title, audience: 'curious general audience', objective: 'explain the mechanism clearly', targetDurationSeconds: 24 },
    stages: ['RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'ASSETS', 'TIMELINE', 'RENDER', 'QA', 'PUBLISH'],
  });

  const artifacts = results.stages.flatMap((stage) => stage.artifacts);
  const renderArtifact = artifacts.find((artifact) => artifact.kind === 'render');
  const qaArtifact = artifacts.find((artifact) => artifact.kind === 'qa');
  if (!renderArtifact || !qaArtifact) throw new Error('Demo pipeline did not create render and QA artifacts');

  // The in-memory lifecycle intentionally requires explicit review; demo does not fake approval.
  const handoffBlocked = (() => {
    try {
      createShortsHandoff({
        episode: production.episodes.get('demo-episode'),
        renderArtifact,
        scriptArtifact: artifacts.find((a) => a.kind === 'script'),
        scenePlanArtifact: artifacts.find((a) => a.kind === 'scene-plan'),
        candidateSegments: [{ id: 'segment-1', startSeconds: 0, endSeconds: 20, title: 'Volcano pressure builds' }],
      });
      return false;
    } catch (error) {
      return { blocked: true, reason: error.message };
    }
  })();

  const report = {
    mode: 'demo-only; no external providers, media render, or publishing',
    episodeId: 'demo-episode',
    title,
    workflowStatus: results.status,
    stageCount: results.stages.length,
    stages: results.stages.map((stage) => ({ stage: stage.stage, runStatus: stage.run.status, artifacts: stage.artifacts.map((a) => ({ id: a.id, kind: a.kind, versionId: a.versionId })) })),
    cost: production.providerRuns.episodeCost('demo-episode'),
    shortsHandoff: handoffBlocked,
    note: 'MockMediaProvider emits JSON placeholder artifacts, not video or audio. A human approval and a real render provider are required before Shorts handoff.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
