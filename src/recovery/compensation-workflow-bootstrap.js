'use strict';
const { EpisodeWorkflowIntegration } = require('../pipeline/episode-workflow-integration');
const { CompensationSagaService } = require('./compensation-saga');
if (!EpisodeWorkflowIntegration.prototype.__forgeCompensationPlanPatched) {
  EpisodeWorkflowIntegration.prototype.__forgeCompensationPlanPatched = true;
  const originalStart = EpisodeWorkflowIntegration.prototype.start;
  EpisodeWorkflowIntegration.prototype.start = async function compensationAwareStart(args = {}) {
    const workflow = await originalStart.call(this, args);
    try { await new CompensationSagaService({ pool: this.pool }).ensurePlan({ workflowId: workflow.id, actor: args.actor || 'workflow' }); }
    catch (error) {
      if (error?.code === 'NOT_FOUND') throw error;
      throw Object.assign(new Error(`Compensation plan creation failed: ${error.message}`), { code: 'COMPENSATION_PLAN_CREATE_FAILED', cause: error });
    }
    return workflow;
  };
}
module.exports = {};
