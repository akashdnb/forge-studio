const crypto = require('node:crypto');
const { requiredString } = require('../domain/records');
const { PIPELINE_STAGES } = require('./provider-pipeline');

const DEFAULT_STAGE_CAPABILITIES = Object.freeze({
  RESEARCH: 'research',
  SCRIPT: 'llm',
  SCENE_PLAN: 'scene-plan',
  NARRATION: 'tts',
  ASSETS: 'image',
  TIMELINE: 'timeline',
  RENDER: 'render',
  QA: 'qa',
  PUBLISH: 'publish',
});

class PipelineService {
  constructor({ runner, stageCapabilities = DEFAULT_STAGE_CAPABILITIES, persistStageResult = async () => {} }) {
    if (!runner || typeof runner.runStage !== 'function') throw new TypeError('runner.runStage is required');
    this.runner = runner;
    this.stageCapabilities = { ...stageCapabilities };
    this.persistStageResult = persistStageResult;
  }

  async run({ episodeId, stage, request, inputVersionIds = [], provider = null, actor = 'pipeline' }) {
    episodeId = requiredString(episodeId, 'episodeId');
    if (!PIPELINE_STAGES.includes(stage)) throw new Error(`Unknown pipeline stage: ${stage}`);
    const capability = provider || this.stageCapabilities[stage];
    if (!capability) throw new Error(`No capability mapping for stage: ${stage}`);
    const canonicalInput = JSON.stringify({ episodeId, stage, capability, request, inputVersionIds: [...inputVersionIds] });
    const idempotencyKey = crypto.createHash('sha256').update(canonicalInput).digest('hex');
    const runId = `run-${idempotencyKey.slice(0, 24)}`;
    const result = await this.runner.runStage({
      id: runId, episodeId, stage, capability,
      providerRequest: request, inputVersionIds, idempotencyKey, createdBy: actor,
    });
    await this.persistStageResult({ episodeId, stage, run: result.run, artifacts: result.artifacts, inputVersionIds });
    return { stage, run: result.run, artifacts: result.artifacts, reused: result.reused };
  }
}

module.exports = { PipelineService, DEFAULT_STAGE_CAPABILITIES };
