const { EpisodeWorkflowIntegration, WORKFLOW_STAGES, WORKFLOW_DEPENDENCIES } = require('./episode-workflow-integration');
const { WorkflowTemplateService } = require('../workflow-templates/service');
class AsyncEpisodeOrchestrator {
  constructor({ pool, leaseSeconds = 300 }) { if (!pool) throw new TypeError('pool is required'); this.pool=pool; this.integration=new EpisodeWorkflowIntegration({pool,leaseSeconds}); this.queue=this.integration.queue; this.templates=new WorkflowTemplateService({pool}); }
  async enqueue({ episodeId, projectId=null, brief, stages=WORKFLOW_STAGES, actor='workflow', idempotencyPrefix=null, tenantId=null }) {
    const episode=(await this.pool.query('SELECT e.*,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1',[episodeId])).rows[0];
    const effectiveTenant=tenantId||episode?.tenant_id||actor;
    const active=(await this.pool.query("SELECT v.id FROM forge_workflow_templates t JOIN forge_workflow_template_versions v ON v.id=t.active_version_id WHERE t.tenant_id=$1 AND t.status='ACTIVE' AND v.status='ACTIVE' ORDER BY t.updated_at DESC LIMIT 1",[effectiveTenant])).rows[0];
    if(active){const plan=await this.templates.compilePlan({tenantId:effectiveTenant,episodeId,actor,templateVersionId:active.id});const dispatched=await this.templates.dispatchPlan(plan.id,effectiveTenant,actor,this.queue);return{episodeId,workflowId:null,executionPlanId:plan.id,status:dispatched.status,jobs:dispatched.stages.filter(s=>s.job_id).map(s=>({id:s.job_id,kind:`workflow:${s.runtime_stage.toLowerCase()}`,episode_id:episodeId,status:s.status})),stages:dispatched.stages,templateVersionId:active.id};}
    const workflow=await this.integration.start({episodeId,projectId,brief,stages,actor,idempotencyKey:idempotencyPrefix&&`${idempotencyPrefix}:${episodeId}`});return{episodeId,workflowId:workflow.id,status:workflow.status,jobs:workflow.stages.filter(stage=>stage.job_id).map(stage=>({id:stage.job_id,kind:`workflow:${stage.stage.toLowerCase()}`,episode_id:episodeId,status:stage.status,depends_on_job_id:null})),stages:workflow.stages};
  }
}
module.exports={AsyncEpisodeOrchestrator,WORKFLOW_STAGE_ORDER:WORKFLOW_STAGES,WORKFLOW_STAGE_DEPENDENCIES:WORKFLOW_DEPENDENCIES};
