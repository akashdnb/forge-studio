'use strict';

const { createHash, randomUUID } = require('node:crypto');

const STATES = new Set(['RUNNABLE','PAUSING','PAUSED','RESUMING','CANCELLED','COMPLETED','FAILED','INTERVENTION']);
const TERMINAL = new Set(['CANCELLED','COMPLETED','FAILED']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, statusCode=409) => Object.assign(new Error(message), { code, statusCode });

function safeCheckpointState(plan, stages) {
  return {
    planStatus: plan.status,
    planId: plan.id,
    templateVersionId: plan.template_version_id,
    releaseEpoch: Number(plan.release_epoch),
    stages: stages.map(s => ({
      id: s.stage_id,
      runtimeStage: s.runtime_stage,
      status: s.status,
      jobId: s.job_id || null,
      outputVersionIds: s.output_version_ids || [],
      outputArtifactIds: s.output_artifact_ids || [],
    })),
  };
}

class WorkflowControlService {
  constructor({ pool, logger=console }={}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.logger = logger;
  }

  async ensure(planId, tenantId, actor='system', client=this.pool) {
    const existing = (await client.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
    if (existing) return existing;
    const plan = (await client.query('SELECT id,tenant_id,template_version_id FROM forge_execution_plans WHERE id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
    if (!plan) throw fail('NOT_FOUND','Execution plan not found',404);
    const token = randomUUID();
    await client.query(`INSERT INTO forge_workflow_controls(plan_id,tenant_id,template_version_id,fence_token) VALUES($1,$2,$3,$4) ON CONFLICT(plan_id) DO NOTHING`,[planId,tenantId,plan.template_version_id,token]);
    return (await client.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
  }

  async get(planId, tenantId) {
    const control = (await this.pool.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
    if (!control) return null;
    const checkpoint = control.active_checkpoint_id ? (await this.pool.query('SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2',[control.active_checkpoint_id,tenantId])).rows[0] : null;
    const intervention = control.active_intervention_id ? (await this.pool.query('SELECT * FROM forge_workflow_interventions WHERE id=$1 AND tenant_id=$2',[control.active_intervention_id,tenantId])).rows[0] : null;
    return { ...control, checkpoint, intervention };
  }

  async assertRunnable(planId, tenantId, expectedEpoch=null, expectedFence=null) {
    const row = (await this.pool.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
    if (!row) return { ok:true, executionEpoch:expectedEpoch, fenceToken:expectedFence };
    if (!['RUNNABLE','RESUMING'].includes(row.state)) throw fail('WORKFLOW_FENCED',`Workflow is ${row.state.toLowerCase()}`);
    if (expectedEpoch != null && Number(expectedEpoch)!==Number(row.execution_epoch)) throw fail('STALE_WORKFLOW_EPOCH','Workflow execution epoch is stale');
    if (expectedFence && String(expectedFence)!==String(row.fence_token)) throw fail('STALE_WORKFLOW_FENCE','Workflow fence token is stale');
    return { ok:true, executionEpoch:Number(row.execution_epoch), fenceToken:row.fence_token };
  }

  async pause({planId,tenantId,actor='operator',reason='operator pause',idempotencyKey}) {
    if (!idempotencyKey) throw fail('IDEMPOTENCY_REQUIRED','Idempotency key is required',400);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const prior=(await c.query('SELECT * FROM forge_workflow_control_events WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,idempotencyKey])).rows[0];
      if(prior){await c.query('COMMIT');return this.get(planId,tenantId)}
      const control=await this.ensure(planId,tenantId,actor,c);
      const locked=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];
      if(TERMINAL.has(locked.state)) throw fail('WORKFLOW_TERMINAL',`Workflow is ${locked.state.toLowerCase()}`);
      const nextEpoch=Number(locked.execution_epoch)+1, nextFence=randomUUID(), checkpointId=randomUUID();
      const plan=(await c.query('SELECT * FROM forge_execution_plans WHERE id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];
      const stages=(await c.query('SELECT * FROM forge_execution_plan_stages WHERE plan_id=$1 ORDER BY created_at,id',[planId])).rows;
      const state=safeCheckpointState(plan,stages);
      const contract={schemaVersion:1,entry:'workflow-stage',stageId:stages.find(s=>['QUEUED','RUNNING','FAILED'].includes(s.status))?.stage_id||null,allowedReentry:['RETRY_FROM_CHECKPOINT','MANUAL_DECISION','SKIP_WITH_APPROVAL'],compensationRequired:true};
      await c.query(`INSERT INTO forge_workflow_checkpoints(id,plan_id,tenant_id,template_version_id,execution_epoch,checkpoint_version,stage_id,runtime_stage,safe_state,reentry_contract,state_hash) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(max(checkpoint_version),0)+1 FROM forge_workflow_checkpoints WHERE plan_id=$2),$6,$7,$8::jsonb,$9::jsonb,$10)`,[checkpointId,planId,tenantId,plan.template_version_id,nextEpoch,contract.stageId,stages.find(s=>s.stage_id===contract.stageId)?.runtime_stage||null,JSON.stringify(state),JSON.stringify(contract),hash(state)]);
      await c.query(`UPDATE forge_workflow_controls SET state='PAUSED',execution_epoch=$2,fence_token=$3,control_version=control_version+1,active_checkpoint_id=$4,active_intervention_id=NULL,updated_at=now() WHERE plan_id=$1`,[planId,nextEpoch,nextFence,checkpointId]);
      await c.query(`UPDATE forge_jobs SET workflow_execution_epoch=$2,workflow_fence_token=$3,cancellation_requested_at=COALESCE(cancellation_requested_at,now()),updated_at=now() WHERE payload->>'executionPlanId'=$1 AND status IN ('QUEUED','RUNNING')`,[planId,nextEpoch,nextFence]);
      await c.query(`UPDATE forge_execution_runs SET workflow_execution_epoch=$2,workflow_fence_token=$3,cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE job_id IN (SELECT id FROM forge_jobs WHERE payload->>'executionPlanId'=$1) AND status IN ('DISPATCHING','QUEUED','IN_PROGRESS')`,[planId,nextEpoch,nextFence]);
      await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'PAUSED',$4,$5,$6,$7::jsonb)`,[planId,tenantId,nextEpoch,actor,idempotencyKey,checkpointId,JSON.stringify({reason,previousEpoch:locked.execution_epoch})]);
      await c.query('COMMIT');
      return this.get(planId,tenantId);
    } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e} finally{c.release()}
  }

  async resume({planId,tenantId,actor='operator',idempotencyKey}) {
    if(!idempotencyKey) throw fail('IDEMPOTENCY_REQUIRED','Idempotency key is required',400);
    const c=await this.pool.connect();try{await c.query('BEGIN');
      const prior=(await c.query('SELECT * FROM forge_workflow_control_events WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,idempotencyKey])).rows[0];if(prior){await c.query('COMMIT');return this.get(planId,tenantId)}
      const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];if(!row)throw fail('NOT_FOUND','Workflow control not found',404);if(row.state!=='PAUSED')throw fail('INVALID_TRANSITION',`Cannot resume from ${row.state}`);
      const cp=(await c.query('SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND plan_id=$2 AND tenant_id=$3',[row.active_checkpoint_id,planId,tenantId])).rows[0];if(!cp)throw fail('CHECKPOINT_MISSING','Active checkpoint is missing');if(cp.template_version_id!==row.template_version_id)throw fail('CHECKPOINT_VERSION_MISMATCH','Checkpoint belongs to another immutable workflow version');
      const nextEpoch=Number(row.execution_epoch)+1,nextFence=randomUUID();
      await c.query(`UPDATE forge_workflow_controls SET state='RESUMING',execution_epoch=$2,fence_token=$3,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,nextEpoch,nextFence]);
      await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'RESUMING',$4,$5,$6,'{}')`,[planId,tenantId,nextEpoch,actor,idempotencyKey,cp.id]);
      await c.query(`UPDATE forge_workflow_controls SET state='RUNNABLE',control_version=control_version+1,updated_at=now() WHERE plan_id=$1 AND state='RESUMING'`,[planId]);
      await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'RESUMED',$4,$5,$6,'{}')`,[planId,tenantId,nextEpoch,actor,`${idempotencyKey}:resumed`,cp.id]);
      await c.query('COMMIT');return this.get(planId,tenantId);
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async cancel({planId,tenantId,actor='operator',reason='operator cancellation',idempotencyKey}) {
    if(!idempotencyKey) throw fail('IDEMPOTENCY_REQUIRED','Idempotency key is required',400);
    const c=await this.pool.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];if(!row)throw fail('NOT_FOUND','Workflow control not found',404);if(TERMINAL.has(row.state)){await c.query('COMMIT');return this.get(planId,tenantId)}const epoch=Number(row.execution_epoch)+1,token=randomUUID();await c.query(`UPDATE forge_workflow_controls SET state='CANCELLED',execution_epoch=$2,fence_token=$3,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,epoch,token]);await c.query(`UPDATE forge_execution_plans SET status='CANCELLED',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,[planId,tenantId]);await c.query(`UPDATE forge_jobs SET cancellation_requested_at=COALESCE(cancellation_requested_at,now()),updated_at=now() WHERE payload->>'executionPlanId'=$1 AND status IN ('QUEUED','RUNNING')`,[planId]);await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'CANCELLED',$4,$5,$6::jsonb) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,[planId,tenantId,epoch,actor,idempotencyKey,JSON.stringify({reason})]);await c.query('COMMIT');return this.get(planId,tenantId)}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async retryFromCheckpoint({planId,tenantId,actor='operator',idempotencyKey}) {
    const c=await this.pool.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];if(!row)throw fail('NOT_FOUND','Workflow control not found',404);const cp=(await c.query('SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND plan_id=$2',[row.active_checkpoint_id,planId])).rows[0];if(!cp)throw fail('CHECKPOINT_MISSING','No resumable checkpoint exists');if(!cp.reentry_contract.allowedReentry.includes('RETRY_FROM_CHECKPOINT'))throw fail('REENTRY_NOT_ALLOWED','Checkpoint does not allow retry');const epoch=Number(row.execution_epoch)+1,token=randomUUID();await c.query(`UPDATE forge_workflow_controls SET state='RUNNABLE',execution_epoch=$2,fence_token=$3,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,epoch,token]);const stageId=cp.reentry_contract.stageId;await c.query(`UPDATE forge_execution_plan_stages SET status='BLOCKED',updated_at=now() WHERE plan_id=$1 AND stage_id=$2 AND status='FAILED'`,[planId,stageId]);await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'RETRY_FROM_CHECKPOINT',$4,$5,$6,'{}') ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,[planId,tenantId,epoch,actor,idempotencyKey,cp.id]);await c.query('COMMIT');return this.get(planId,tenantId)}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async intervene({planId,tenantId,actor='operator',kind='MANUAL',stageId=null,reason='manual intervention',idempotencyKey}) {
    if(!idempotencyKey)throw fail('IDEMPOTENCY_REQUIRED','Idempotency key is required',400);const c=await this.pool.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];if(!row)throw fail('NOT_FOUND','Workflow control not found',404);const cp=(await c.query('SELECT * FROM forge_workflow_checkpoints WHERE id=$1',[row.active_checkpoint_id])).rows[0];if(!cp)throw fail('CHECKPOINT_REQUIRED','Pause the workflow before opening an intervention');const id=randomUUID();await c.query(`INSERT INTO forge_workflow_interventions(id,plan_id,tenant_id,execution_epoch,checkpoint_id,stage_id,kind,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,planId,tenantId,row.execution_epoch,cp.id,stageId||cp.stage_id,kind,actor]);await c.query(`UPDATE forge_workflow_controls SET state='INTERVENTION',active_intervention_id=$2,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,id]);await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,intervention_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'INTERVENTION_OPENED',$4,$5,$6,$7,$8::jsonb) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,[planId,tenantId,row.execution_epoch,actor,idempotencyKey,cp.id,id,JSON.stringify({reason,kind})]);await c.query('COMMIT');return this.get(planId,tenantId)}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async decideIntervention({planId,tenantId,interventionId,decision,actor='operator',idempotencyKey}) {
    const c=await this.pool.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];const i=(await c.query('SELECT * FROM forge_workflow_interventions WHERE id=$1 AND plan_id=$2 AND tenant_id=$3 FOR UPDATE',[interventionId,planId,tenantId])).rows[0];if(!row||!i)throw fail('NOT_FOUND','Intervention not found',404);if(i.status!=='OPEN')throw fail('INVALID_TRANSITION','Intervention is no longer open');const status=decision?.approved?'APPROVED':'REJECTED';await c.query(`UPDATE forge_workflow_interventions SET status=$2,decision=$3::jsonb,decided_by=$4,decided_at=now() WHERE id=$1`,[interventionId,status,JSON.stringify(decision||{}),actor]);if(status==='APPROVED')await c.query(`UPDATE forge_workflow_controls SET state='RUNNABLE',active_intervention_id=NULL,execution_epoch=execution_epoch+1,fence_token=$2,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,randomUUID()]);else await c.query(`UPDATE forge_workflow_controls SET state='PAUSED',active_intervention_id=NULL,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId]);await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,intervention_id,details) VALUES($1,$2,(SELECT execution_epoch FROM forge_workflow_controls WHERE plan_id=$1),(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'INTERVENTION_DECIDED',$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,[planId,tenantId,actor,idempotencyKey,interventionId,JSON.stringify(decision||{})]);await c.query('COMMIT');return this.get(planId,tenantId)}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async skipWithApproval({planId,tenantId,stageId,actor='operator',approvalReference,idempotencyKey}) {
    if(!approvalReference)throw fail('APPROVAL_REQUIRED','Approval reference is required',400);
    const c=await this.pool.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE',[planId,tenantId])).rows[0];if(!row)throw fail('NOT_FOUND','Workflow control not found',404);if(!['PAUSED','INTERVENTION'].includes(row.state))throw fail('WORKFLOW_NOT_PAUSED','Skip requires a paused workflow');const cp=(await c.query('SELECT * FROM forge_workflow_checkpoints WHERE id=$1',[row.active_checkpoint_id])).rows[0];if(!cp)throw fail('CHECKPOINT_REQUIRED','No checkpoint available');await c.query(`UPDATE forge_execution_plan_stages SET status='SUCCEEDED',updated_at=now() WHERE plan_id=$1 AND stage_id=$2 AND status IN ('BLOCKED','FAILED')`,[planId,stageId]);const epoch=Number(row.execution_epoch)+1,token=randomUUID();await c.query(`UPDATE forge_workflow_controls SET state='RUNNABLE',execution_epoch=$2,fence_token=$3,control_version=control_version+1,updated_at=now() WHERE plan_id=$1`,[planId,epoch,token]);await c.query(`INSERT INTO forge_workflow_control_events(plan_id,tenant_id,execution_epoch,control_version,event_type,actor,idempotency_key,checkpoint_id,details) VALUES($1,$2,$3,(SELECT control_version FROM forge_workflow_controls WHERE plan_id=$1),'SKIPPED_WITH_APPROVAL',$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,[planId,tenantId,epoch,actor,idempotencyKey,cp.id,JSON.stringify({stageId,approvalReference})]);await c.query('COMMIT');return this.get(planId,tenantId)}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  }

  async admitJob(job) {
    const planId=job?.payload?.executionPlanId;if(!planId)return true;const tenantId=job?.payload?.tenantId;if(!tenantId)return false;const row=(await this.pool.query('SELECT state,execution_epoch,fence_token FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2',[planId,tenantId])).rows[0];if(!row)return true;if(!['RUNNABLE','RESUMING'].includes(row.state)){await this.pool.query(`UPDATE forge_jobs SET status='CANCELLED',updated_at=now(),error=$2::jsonb WHERE id=$1 AND status='RUNNING'`,[job.id,JSON.stringify({code:'WORKFLOW_FENCED',state:row.state})]);return false;}if(job.workflow_execution_epoch&&Number(job.workflow_execution_epoch)!==Number(row.execution_epoch))return false;return true;
  }
}

module.exports={WorkflowControlService,STATES,hash};
