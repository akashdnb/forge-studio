const { randomUUID } = require('node:crypto');
const { JobQueue } = require('../persistence/job-queue');
const { WORKFLOW_DEPENDENCIES } = require('./workflow');

const ORDER = ['RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'TRANSCRIPTION', 'ASSETS', 'TIMELINE', 'RENDER', 'QA', 'PUBLISH'];

class AsyncEpisodeOrchestrator {
  constructor({ pool, leaseSeconds = 300 }) { this.queue = new JobQueue({ pool, leaseSeconds }); }

  async enqueue({ episodeId, projectId = null, brief, stages = ORDER, actor = 'workflow', idempotencyPrefix = randomUUID() }) {
    if (!episodeId) throw new TypeError('episodeId is required');
    if (!String(brief || '').trim()) throw new TypeError('brief is required');
    const requested = new Set(stages);
    for (const stage of stages) {
      if (!ORDER.includes(stage)) throw new TypeError(`Unknown workflow stage: ${stage}`);
      for (const dependency of WORKFLOW_DEPENDENCIES[stage] || []) if (!requested.has(dependency)) throw new Error(`Stage ${stage} requires ${dependency}`);
    }
    const jobs = [];
    const jobByStage = new Map();
    for (const stage of stages) {
      const dependencyJobs = (WORKFLOW_DEPENDENCIES[stage] || []).map((dependency) => jobByStage.get(dependency)).filter(Boolean);
      if (dependencyJobs.length > 1) throw new Error(`Stage ${stage} has multiple dependencies; durable queue currently supports one dependency`);
      const dependsOnJobId = dependencyJobs[0]?.id || null;
      const job = await this.queue.enqueue({
        projectId, episodeId, kind: `workflow:${stage.toLowerCase()}`,
        payload: { episodeId, projectId, brief, stage, actor },
        idempotencyKey: `${idempotencyPrefix}:${episodeId}:${stage}`, createdBy: actor, dependsOnJobId,
      });
      jobs.push(job); jobByStage.set(stage, job);
    }
    return { episodeId, jobs };
  }
}

module.exports = { AsyncEpisodeOrchestrator, WORKFLOW_STAGE_ORDER: ORDER };
