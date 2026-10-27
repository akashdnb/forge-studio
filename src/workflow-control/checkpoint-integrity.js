'use strict';

const { createHash, randomUUID } = require('node:crypto');

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const stableEnvelope = envelope => { const copy={...envelope}; delete copy.actor; return copy; };
const fail = (code, message, statusCode=409) => Object.assign(new Error(message), { code, statusCode });

async function providerSnapshot(pool, tenantId, projectId, episodeId) {
  const policy = (await pool.query(`SELECT provider,model,operation,epoch,enabled,active,priority,weight,max_concurrency,rate_per_second,burst,lease_ms,cooldown_ms FROM provider_execution_policies WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND active=true ORDER BY provider,model,operation,epoch DESC`, [tenantId, projectId])).rows;
  const decisions = (await pool.query(`SELECT provider,model,operation,decision_id,allowed,policy_epoch,priority,weight,concurrency_limit,rate_per_second FROM provider_admission_decisions WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND (episode_id=$3 OR episode_id IS NULL) AND created_at > now()-interval '24 hours' ORDER BY created_at,decision_id`, [tenantId, projectId, episodeId])).rows;
  return { policy, decisions };
}

async function credentialSnapshot(pool, tenantId, projectId, planId) {
  return (await pool.query(`SELECT credential_id,credential_version,provider,model,purpose,workflow_id,job_id,attempt_id,execution_epoch,fencing_token,state,expires_at,revoked_at,released_at FROM forge_credential_access_leases WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND (workflow_id=$3 OR job_id IN (SELECT id FROM forge_jobs WHERE payload->>'executionPlanId'=$3)) ORDER BY credential_id,credential_version,id`, [tenantId, projectId, planId])).rows;
}

async function buildEnvelope({pool, planId, tenantId, checkpoint, actor='system'}) {
  const plan = (await pool.query(`SELECT id,tenant_id,project_id,episode_id,template_version_id,template_content_hash,release_epoch,status,snapshot,content_hash,schema_family,schema_version,schema_hash,execution_snapshot_id FROM forge_execution_plans WHERE id=$1 AND tenant_id=$2`, [planId, tenantId])).rows[0];
  if (!plan) throw fail('NOT_FOUND', 'Execution plan not found', 404);
  const stages = (await pool.query(`SELECT id,stage_id,runtime_stage,depends_on,input_contract,output_contract,retry_policy,timeout_seconds,status,job_id,output_version_ids,output_artifact_ids FROM forge_execution_plan_stages WHERE plan_id=$1 ORDER BY created_at,id`, [planId])).rows;
  const stage = checkpoint.stage_id ? stages.find(s => s.stage_id === checkpoint.stage_id) : null;
  if (checkpoint.stage_id && !stage) throw fail('CHECKPOINT_STAGE_MISSING', 'Checkpoint stage no longer exists');
  const run = stage?.job_id ? (await pool.query(`SELECT id,job_id,attempt_id,manifest_version,manifest_hash,result_hash,status,workflow_execution_epoch,workflow_fence_token,schema_family,schema_version,schema_hash,manifest_expires_at FROM forge_execution_runs WHERE job_id=$1 ORDER BY updated_at DESC LIMIT 1`, [stage.job_id])).rows[0] : null;
  const provider = await providerSnapshot(pool, tenantId, plan.project_id, plan.episode_id);
  const credentials = await credentialSnapshot(pool, tenantId, plan.project_id, planId);
  const stageState = stages.map(s => ({ id:s.id, stageId:s.stage_id, runtimeStage:s.runtime_stage, status:s.status, jobId:s.job_id, inputContract:s.input_contract, outputContract:s.output_contract, outputVersionIds:s.output_version_ids||[], outputArtifactIds:s.output_artifact_ids||[] }));
  const inputs = { planSnapshot:plan.snapshot, stage: stageState, workflowRun:run ? { id:run.id, attemptId:run.attempt_id, manifestVersion:run.manifest_version, manifestHash:run.manifest_hash, resultHash:run.result_hash } : null };
  const outputs = { stage: stage ? { outputVersionIds:stage.output_version_ids||[], outputArtifactIds:stage.output_artifact_ids||[] } : null };
  const envelope = {
    checkpointVersion: Number(checkpoint.checkpoint_version), checkpointEpoch:Number(checkpoint.execution_epoch),
    planId, tenantId, projectId:plan.project_id, episodeId:plan.episode_id,
    templateVersionId:plan.template_version_id, templateContentHash:plan.template_content_hash, releaseEpoch:Number(plan.release_epoch),
    schemaFamily:plan.schema_family, schemaVersion:Number(plan.schema_version), schemaHash:plan.schema_hash, executionSnapshotId:plan.execution_snapshot_id,
    planHash:plan.content_hash, stageVersion:checkpoint.stage_version || '1', stageId:checkpoint.stage_id || null, runtimeStage:checkpoint.runtime_stage || null,
    workflowRunId:run?.id || null, inputFingerprint:hash(inputs), outputFingerprint:hash(outputs), providerStateHash:hash(provider), credentialStateHash:hash(credentials),
    admissionStateHash:hash(provider.decisions), deadlineAt:run?.manifest_expires_at || null,
    sideEffectBoundary: checkpoint.side_effect_boundary || 'NONE', safeState:checkpoint.safe_state, reentryContract:checkpoint.reentry_contract,
    actor
  };
  return { envelope, provider, credentials, run };
}

async function captureStageCheckpoint({pool,planId,tenantId,actor='workflow',stageId=null}) {
  const c=await pool.connect();let checkpointId=null;
  try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`forge-workflow-checkpoint:${tenantId}:${planId}`]);
    const control=(await c.query(`SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2 FOR UPDATE`,[planId,tenantId])).rows[0];
    if(!control||!['RUNNABLE','RESUMING'].includes(control.state)){await c.query('ROLLBACK');return null;}
    const stages=(await c.query(`SELECT * FROM forge_execution_plan_stages WHERE plan_id=$1 ORDER BY created_at,id`,[planId])).rows;
    const stage=stageId?stages.find(s=>s.stage_id===stageId):stages.find(s=>['QUEUED','RUNNING','FAILED'].includes(s.status));
    if(!stage){await c.query('ROLLBACK');return null;}
    const safeState={planId,templateVersionId:control.template_version_id,executionEpoch:Number(control.execution_epoch),stages:stages.map(s=>({id:s.stage_id,runtimeStage:s.runtime_stage,status:s.status,jobId:s.job_id,outputVersionIds:s.output_version_ids||[],outputArtifactIds:s.output_artifact_ids||[]}))};
    checkpointId=randomUUID();
    const sideEffectBoundary=['PUBLISH','PACKAGING','RENDER','ASSETS','NARRATION','TRANSCRIPTION','RESEARCH'].includes(String(stage.runtime_stage).toUpperCase())?'EXTERNAL':'NONE';
    const contract={schemaVersion:2,entry:'workflow-stage',stageId:stage.stage_id,allowedReentry:['RETRY_FROM_CHECKPOINT'],compensationRequired:stage.status==='FAILED',safeReplay:sideEffectBoundary==='NONE'};
    const result=await c.query(`INSERT INTO forge_workflow_checkpoints(id,plan_id,tenant_id,template_version_id,execution_epoch,checkpoint_version,stage_id,runtime_stage,safe_state,reentry_contract,schema_version,state_hash,side_effect_boundary) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(max(checkpoint_version),0)+1 FROM forge_workflow_checkpoints WHERE plan_id=$2),$6,$7,$8::jsonb,$9::jsonb,1,$10,$11) ON CONFLICT(plan_id,execution_epoch,stage_id) DO NOTHING RETURNING id`,[checkpointId,planId,tenantId,control.template_version_id,control.execution_epoch,stage.stage_id,stage.runtime_stage,JSON.stringify(safeState),JSON.stringify(contract),hash(safeState),sideEffectBoundary]);
    if(!result.rows[0]){await c.query('COMMIT');return (await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE plan_id=$1 AND execution_epoch=$2 AND stage_id=$3`,[planId,control.execution_epoch,stage.stage_id])).rows[0]||null;}
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error}finally{c.release()}
  return sealCheckpoint({pool,checkpointId,tenantId,actor});
}

async function sealCheckpoint({pool, checkpointId, tenantId, actor='system'}) {
  const cp=(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
  if(!cp) throw fail('CHECKPOINT_MISSING','Checkpoint not found',404);
  const {envelope}=await buildEnvelope({pool,planId:cp.plan_id,tenantId,checkpoint:cp,actor});
  const validationHash=hash(stableEnvelope(envelope));
  await pool.query(`UPDATE forge_workflow_checkpoints SET checkpoint_epoch=$2,workflow_run_id=$3,release_epoch=$4,execution_snapshot_id=$5,plan_hash=$6,input_fingerprint=$7,output_fingerprint=$8,provider_state_hash=$9,credential_state_hash=$10,admission_state_hash=$11,deadline_at=$12,validity='VALID',validated_at=now(),validated_by=$13,validation_hash=$14,schema_family=$15,schema_hash=$16,updated_at=now() WHERE id=$1 AND tenant_id=$17`,[checkpointId,envelope.checkpointEpoch,envelope.workflowRunId,envelope.releaseEpoch,envelope.executionSnapshotId,envelope.planHash,envelope.inputFingerprint,envelope.outputFingerprint,envelope.providerStateHash,envelope.credentialStateHash,envelope.admissionStateHash,envelope.deadlineAt,actor,validationHash,envelope.schemaFamily,envelope.schemaHash,tenantId]);
  return (await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
}

async function validateCheckpoint({pool, checkpointId, tenantId, actor='system', allowExpired=false}) {
  const cp=(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
  if(!cp) throw fail('CHECKPOINT_MISSING','Checkpoint not found',404);
  if(cp.validity==='QUARANTINED') throw fail('CHECKPOINT_QUARANTINED','Checkpoint is quarantined');
  const {envelope}=await buildEnvelope({pool,planId:cp.plan_id,tenantId,checkpoint:cp,actor});
  const mismatches=[];
  for(const key of ['templateVersionId','templateContentHash','releaseEpoch','executionSnapshotId','schemaFamily','schemaVersion','schemaHash','planHash','inputFingerprint','outputFingerprint','providerStateHash','credentialStateHash','admissionStateHash','sideEffectBoundary','workflowRunId']) {
    const column = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
    if(cp[column] != null && String(cp[column]) !== String(envelope[key])) mismatches.push(key);
  }
  if(cp.checkpoint_epoch != null && Number(cp.checkpoint_epoch)!==Number(envelope.checkpointEpoch)) mismatches.push('checkpointEpoch');
  if(cp.deadline_at && !allowExpired && new Date(cp.deadline_at).getTime() <= Date.now()) mismatches.push('deadlineExpired');
  if(hash(cp.safe_state)!==cp.state_hash) mismatches.push('stateHash');
  if(cp.validation_hash && cp.validation_hash!==hash(stableEnvelope(envelope))) mismatches.push('validationHash');
  const valid=mismatches.length===0;
  await pool.query(`INSERT INTO forge_workflow_checkpoint_diagnostics(checkpoint_id,tenant_id,plan_id,execution_epoch,outcome,reason,evidence,actor) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[cp.id,tenantId,cp.plan_id,cp.execution_epoch,valid?'VALID':'INVALID',valid?null:'Checkpoint compatibility or integrity validation failed',JSON.stringify({mismatches,current:{templateVersionId:envelope.templateVersionId,releaseEpoch:envelope.releaseEpoch,executionSnapshotId:envelope.executionSnapshotId,schemaHash:envelope.schemaHash,providerStateHash:envelope.providerStateHash,credentialStateHash:envelope.credentialStateHash,admissionStateHash:envelope.admissionStateHash}}),actor]);
  await pool.query(`UPDATE forge_workflow_checkpoints SET validity=$2,validated_at=now(),validated_by=$3,invalid_reason=$4,updated_at=now() WHERE id=$1 AND tenant_id=$5`,[cp.id,valid?'VALID':'INVALID',actor,valid?null:mismatches.join(','),tenantId]);
  if(!valid) throw fail('CHECKPOINT_INVALID',`Checkpoint is not safely reusable: ${mismatches.join(',')}`);
  return {valid:true,checkpoint:cp,mismatches:[]};
}

async function quarantineCheckpoint({pool,checkpointId,tenantId,actor='operator',reason='operator quarantine'}) {
  const result=await pool.query(`UPDATE forge_workflow_checkpoints SET validity='QUARANTINED',invalid_reason=$3,validated_at=now(),validated_by=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,[checkpointId,tenantId,reason,actor]);
  if(!result.rows[0]) throw fail('CHECKPOINT_MISSING','Checkpoint not found',404);
  await pool.query(`INSERT INTO forge_workflow_checkpoint_diagnostics(checkpoint_id,tenant_id,plan_id,execution_epoch,outcome,reason,evidence,actor) VALUES($1,$2,$3,$4,'QUARANTINED',$5,'{}',$6)`,[checkpointId,tenantId,result.rows[0].plan_id,result.rows[0].execution_epoch,reason,actor]);
  return result.rows[0];
}

async function admitReentry({pool,planId,tenantId,checkpointId,actor='workflow-control',idempotencyKey}) {
  if(!idempotencyKey) throw fail('IDEMPOTENCY_REQUIRED','Idempotency key is required',400);
  const existing=(await pool.query(`SELECT * FROM forge_workflow_reentry_attempts WHERE tenant_id=$1 AND idempotency_key=$2`,[tenantId,idempotencyKey])).rows[0];
  if(existing) return existing;
  const control=(await pool.query(`SELECT * FROM forge_workflow_controls WHERE plan_id=$1 AND tenant_id=$2`,[planId,tenantId])).rows[0];
  if(!control) throw fail('NOT_FOUND','Workflow control not found',404);
  if(!['RUNNABLE','RESUMING'].includes(control.state)) throw fail('WORKFLOW_FENCED',`Workflow is ${control.state.toLowerCase()}`);
  const cp=(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND plan_id=$2 AND tenant_id=$3`,[checkpointId,planId,tenantId])).rows[0];
  if(!cp) throw fail('CHECKPOINT_MISSING','Checkpoint not found');
  await validateCheckpoint({pool,checkpointId,tenantId,actor});
  const stage=(await pool.query(`SELECT runtime_stage,job_id FROM forge_execution_plan_stages WHERE plan_id=$1 AND stage_id=$2`,[planId,cp.stage_id])).rows[0];
  if(stage?.job_id){
    const uncertain=(await pool.query(`SELECT 1 FROM forge_credential_usage_attestations a WHERE a.tenant_id=$1 AND a.job_id=$2 AND a.outcome='STARTED' AND NOT EXISTS (SELECT 1 FROM forge_credential_usage_attestations s WHERE s.tenant_id=a.tenant_id AND s.job_id=a.job_id AND s.attempt_id=a.attempt_id AND s.operation=a.operation AND s.outcome='SUCCEEDED') LIMIT 1`,[tenantId,stage.job_id])).rows[0];
    if(uncertain)throw fail('REENTRY_SIDE_EFFECT_UNCERTAIN','An external provider operation started without a durable success attestation; quarantine or reconcile before replay');
  }
  if(stage?.runtime_stage==='PUBLISH'){
    const publishing=(await pool.query(`SELECT 1 FROM publish_runs p WHERE p.episode_id=(SELECT episode_id FROM forge_execution_plans WHERE id=$1 AND tenant_id=$2) AND p.status IN ('UPLOADING','PUBLISHED') LIMIT 1`,[planId,tenantId])).rows[0];
    if(publishing)throw fail('REENTRY_PUBLISH_BOUNDARY','Publishing has an in-flight or completed external side effect; replay is blocked');
  }
  const id=randomUUID();
  return (await pool.query(`INSERT INTO forge_workflow_reentry_attempts(id,checkpoint_id,tenant_id,plan_id,execution_epoch,requested_by,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'ADMITTED',$7) RETURNING *`,[id,checkpointId,tenantId,planId,control.execution_epoch,actor,idempotencyKey])).rows[0];
}

module.exports={canonical,hash,buildEnvelope,captureStageCheckpoint,sealCheckpoint,validateCheckpoint,quarantineCheckpoint,admitReentry};
