'use strict';

const { EpisodeWorkflowIntegration } = require('./episode-workflow-integration');

async function reconcileSucceededStages(integration, actor = 'reconciler', workflowId = null) {
  const params = [];
  let filter = '';
  if (workflowId) {
    params.push(workflowId);
    filter = 'AND w.id=$1';
  }
  const rows = await integration.pool.query(`
    SELECT w.id AS workflow_id, s.stage, j.*
    FROM episode_workflows w
    JOIN episode_workflow_stages s ON s.workflow_id=w.id
    JOIN forge_jobs j ON j.id=s.job_id
    WHERE w.status IN ('QUEUED','RUNNING')
      AND s.status IN ('QUEUED','RUNNING')
      AND j.status='SUCCEEDED'
      ${filter}
    ORDER BY w.id, s.stage
  `, params);

  let recovered = 0;
  for (const row of rows.rows) {
    const result = await integration.handleJobSuccess(row, row.result || {});
    if (result?.accepted) recovered += 1;
  }
  return recovered;
}

const originalRecover = EpisodeWorkflowIntegration.prototype.recover;
if (!EpisodeWorkflowIntegration.prototype.__forgeSessionSRecoveryPatched) {
  EpisodeWorkflowIntegration.prototype.recover = async function recoverWithSucceededJobReconciliation(options = {}) {
    const recovered = await reconcileSucceededStages(this, options.actor || 'reconciler', options.workflowId || null);
    const result = await originalRecover.call(this, options);
    return result.map((workflow) => ({ ...workflow, recoveredSucceededStages: recovered }));
  };
  Object.defineProperty(EpisodeWorkflowIntegration.prototype, '__forgeSessionSRecoveryPatched', { value: true });
}

module.exports = { reconcileSucceededStages };
