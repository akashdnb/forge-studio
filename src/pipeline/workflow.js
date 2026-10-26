const { requiredString } = require('../domain/records');
const { normalizeScenePlan } = require('./scene-plan');
const { PIPELINE_STAGES } = require('./provider-pipeline');

const DEPENDENCIES = Object.freeze({
  RESEARCH: [],
  SCRIPT: ['RESEARCH'],
  SCENE_PLAN: ['SCRIPT'],
  NARRATION: ['SCRIPT', 'SCENE_PLAN'],
  TRANSCRIPTION: ['NARRATION'],
  ASSETS: ['SCENE_PLAN'],
  TIMELINE: ['SCENE_PLAN', 'NARRATION', 'ASSETS'],
  RENDER: ['TIMELINE'],
  QA: ['RENDER'],
  PUBLISH: ['QA'],
});

class EpisodeWorkflow {
  constructor({ pipelineService, episodes, artifacts, qa, approvals, maxStageCost = null }) {
    if (!pipelineService) throw new TypeError('pipelineService is required');
    this.pipeline = pipelineService; this.episodes = episodes || null; this.artifacts = artifacts || null; this.qa = qa || null; this.approvals = approvals || null; this.maxStageCost = maxStageCost;
  }

  async execute({ episodeId, brief, stages = PIPELINE_STAGES, actor = 'workflow' }) {
    episodeId = requiredString(episodeId, 'episodeId');
    if (!Array.isArray(stages) || stages.length === 0) throw new TypeError('stages must be a non-empty array');
    const unknown = stages.filter((stage) => !PIPELINE_STAGES.includes(stage));
    if (unknown.length) throw new Error(`Unknown workflow stages: ${unknown.join(', ')}`);
    const requested = new Set(stages);
    for (const stage of stages) for (const dependency of DEPENDENCIES[stage]) if (!requested.has(dependency)) throw new Error(`Stage ${stage} requires ${dependency} in the same workflow request`);

    let previous = { brief }; const outputs = []; const stageVersions = new Map();
    for (const stage of stages) {
      const inputVersionIds = DEPENDENCIES[stage].flatMap((dependency) => stageVersions.get(dependency) || []);
      const request = this.#stageRequest(stage, previous, brief);
      const result = await this.pipeline.run({ episodeId, stage, request, inputVersionIds, actor });
      if (!result.run || result.run.status !== 'SUCCEEDED') throw new Error(`Stage ${stage} did not succeed`);
      const cost = result.run.actualCost ?? result.run.estimatedCost;
      if (this.maxStageCost !== null && cost !== null && cost > this.maxStageCost) throw Object.assign(new Error(`Stage ${stage} exceeded the configured cost guard`), { code: 'COST_GUARD' });
      const versionIds = result.artifacts.map((artifact) => artifact.versionId); stageVersions.set(stage, versionIds); outputs.push({ stage, ...result, inputVersionIds });
      previous = { ...previous, [stage]: result.artifacts, lastResult: result };
      if (stage === 'SCENE_PLAN' && result.artifacts[0]?.content) { const rawPlan = result.artifacts[0].content; const candidate = rawPlan && rawPlan.content && rawPlan.content.scenes ? rawPlan.content : rawPlan; previous.normalizedScenePlan = normalizeScenePlan(candidate); }
    }
    return { episodeId, status: 'SUCCEEDED', stages: outputs, artifactIds: outputs.flatMap((stage) => stage.artifacts.map((artifact) => artifact.id)), versionIds: outputs.flatMap((stage) => stage.artifacts.map((artifact) => artifact.versionId)) };
  }

  #stageRequest(stage, previous, brief) {
    if (stage === 'RESEARCH') return { brief };
    if (stage === 'SCRIPT') return { brief, research: previous.RESEARCH || [] };
    if (stage === 'SCENE_PLAN') return { brief, script: previous.SCRIPT || [] };
    if (stage === 'NARRATION') return { script: previous.SCRIPT || [], scenePlan: previous.SCENE_PLAN || [] };
    if (stage === 'TRANSCRIPTION') return { narration: previous.NARRATION || [] };
    if (stage === 'ASSETS') return { scenePlan: previous.normalizedScenePlan || previous.SCENE_PLAN || [] };
    if (stage === 'TIMELINE') return { scenePlan: previous.normalizedScenePlan || previous.SCENE_PLAN || [], narration: previous.NARRATION || [], transcription: previous.TRANSCRIPTION || [], assets: previous.ASSETS || [] };
    if (stage === 'RENDER') return { timeline: previous.TIMELINE || [] };
    if (stage === 'QA') return { render: previous.RENDER || [] };
    if (stage === 'PUBLISH') return { render: previous.RENDER || [], qa: previous.QA || [] };
    throw new Error(`No request mapping for stage ${stage}`);
  }
}

module.exports = { EpisodeWorkflow, WORKFLOW_DEPENDENCIES: DEPENDENCIES };
