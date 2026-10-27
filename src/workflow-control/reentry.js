'use strict';
const { WorkflowControlService } = require('./service');
const { JobQueue } = require('../persistence/job-queue');
const { WorkflowTemplateService } = require('../workflow-templates/service');

async function reenterFromCheckpoint({pool,planId,tenantId,actor='workflow-control'}){
  const control=new WorkflowControlService({pool});
  const state=await control.get(planId,tenantId);
  if(!state?.checkpoint)return {dispatched:false,reason:'NO_CHECKPOINT'};
  const cp=state.checkpoint;
  const stageId=cp.reentry_contract?.stageId||cp.stage_id;
  if(!stageId)return {dispatched:false,reason:'NO_STAGE'};
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const stage=(await c.query('SELECT * FROM forge_execution_plan_stages WHERE plan_id=$1 AND stage_id=$2 FOR UPDATE',[planId,stageId])).rows[0];
    if(!stage){await c.query('COMMIT');return {dispatched:false,reason:'STAGE_MISSING'};}
    await c.query(`UPDATE forge_jobs SET status='CANCELLED',worker_id=NULL,leased_until=NULL,cancellation_requested_at=COALESCE(cancellation_requested_at,now()),updated_at=now() WHERE payload->>'executionPlanId'=$1 AND payload->>'planStageId'=$2 AND status IN ('QUEUED','RUNNING')`,[planId,stageId]);
    await c.query(`UPDATE forge_execution_plan_stages SET status='BLOCKED',job_id=NULL,updated_at=now() WHERE plan_id=$1 AND stage_id=$2 AND status NOT IN ('SUCCEEDED','CANCELLED')`,[planId,stageId]);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  const plan=(await pool.query('SELECT * FROM forge_execution_plans WHERE id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
  if(!plan)return {dispatched:false,reason:'PLAN_MISSING'};
  const svc=new WorkflowTemplateService({pool});
  const result=await svc.dispatchPlan(planId,tenantId,actor,new JobQueue({pool}));
  return {dispatched:true,plan:result};
}
module.exports={reenterFromCheckpoint};
