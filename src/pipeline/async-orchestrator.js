const { EpisodeWorkflowIntegration, WORKFLOW_STAGES, WORKFLOW_DEPENDENCIES } = require('./episode-workflow-integration');

class AsyncEpisodeOrchestrator {
  constructor({ pool, leaseSeconds = 300 }) {
    if (!pool) throw new TypeError('pool is required');
    this.integration = new EpisodeWorkflowIntegration({ pool, leaseSeconds });
    this.queue = this.integration.queue;
  }

  async enqueue({ episodeId, projectId = null, brief, stages = WORKFLOW_STAGES, actor = 'workflow', idempotencyPrefix = null }) {
    const workflow = await this.integration.start({ episodeId, projectId, brief, stages, actor, idempotencyKey: idempotencyPrefix && `${idempotencyPrefix}:${episodeId}` });
    return {
      episodeId,
      workflowId: workflow.id,
      status: workflow.status,
      jobs: workflow.stages.filter((stage) => stage.job_id).map((stage) => ({ id: stage.job_id, kind: `workflow:${stage.stage.toLowerCase()}`, episode_id: episodeId, status: stage.status, depends_on_job_id: null })),
      stages: workflow.stages,
    };
  }
}

module.exports = { AsyncEpisodeOrchestrator, WORKFLOW_STAGE_ORDER: WORKFLOW_STAGES, WORKFLOW_STAGE_DEPENDENCIES: WORKFLOW_DEPENDENCIES };
