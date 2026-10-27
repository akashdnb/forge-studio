'use strict';

const { createHash, randomUUID } = require('node:crypto');

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (code, message, statusCode=409) => Object.assign(new Error(message), { code, statusCode });

async function providerSnapshot(pool, tenantId, projectId, episodeId) {
  const policy = (await pool.query(`SELECT provider,model,operation,epoch,enabled,active,priority,weight,max_concurrency,rate_per_second,burst,lease_ms,cooldown_ms FROM provider_execution_policies WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND active=true ORDER BY provider,model,operation,epoch DESC`, [tenantId, projectId])).rows;
  const decisions = (await pool.query(`SELECT provider,model,operation,decision_id,allowed,policy_epoch,priority,weight,concurrency_limit,rate_per_second FROM provider_admission_decisions WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND (episode_id=$3 OR episode_id IS NULL) AND created_at > now()-interval '24 hours' ORDER BY created_at,decision_id`, [tenantId, projectId, episodeId])).rows;
  return { policy, decisions };
}

async function credentialSnapshot(pool, tenantId, projectId, planId) {
  const leases = (await pool.query(`SELECT credential_id,credential_version,provider,model,purpose,execution_epoch,fencing_token,state,expires_at FROM forge_credential_access_leases WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND (workflow_id=$3 OR workflow_id IS NULL) AND state IN ('HELD','REVOKED','EXPIRED') ORDER BY credential_id,credential_version,id`, [tenantId, projectId, planId])).rows;
  return leases;
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
  const inputs = { planSnapshot:plan.snapshot, stage: stageState, workflowRun:run ? { attemptId:run.attempt_id, manifestVersion:run.manifest_version, manifestHash:run.manifest_hash, resultHash:run.result_hash } : null };
  const outputs = { stage: stage ? { outputVersionIds:stage.output_version_ids||[], outputArtifactIds:stage.output_artifact_ids||[] } : null };
  const envelope = {
    checkpointVersion: Number(checkpoint.checkpoint_version), checkpointEpoch:Number(checkpoint.execution_epoch),
    planId, tenantId, projectId:plan.project_id, episodeId:plan.episode_id,
    templateVersionId:plan.template_version_id, templateContentHash:plan.template_content_hash, releaseEpoch:Number(plan.release_epoch),
    schemaFamily:plan.schema_family, schemaVersion:Number(plan.schema_version), schemaHash:plan.schema_hash, executionSnapshotId:plan.execution_snapshot_id,
    planHash:plan.content_hash, stageVersion:checkpoint.stage_version || '1', stageId:checkpoint.stage_id || null, runtimeStage:checkpoint.runtime_stage || null,
    inputFingerprint:hash(inputs), outputFingerprint:hash(outputs), providerStateHash:hash(provider), credentialStateHash:hash(credentials),
    admissionStateHash:hash(provider.decisions), deadlineAt:run?.manifest_expires_at || null,
    sideEffectBoundary: checkpoint.side_effect_boundary || 'NONE', safeState:checkpoint.safe_state, reentryContract:checkpoint.reentry_contract,
    actor
  };
  return { envelope, provider, credentials, run };
}

async function sealCheckpoint({pool, checkpointId, tenantId, actor='system'}) {
  const cp=(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
  if(!cp) throw fail('CHECKPOINT_MISSING','Checkpoint not found',404);
  const {envelope}=await buildEnvelope({pool,planId:cp.plan_id,tenantId,checkpoint:cp,actor});
  const validationHash=hash(envelope);
  await pool.query(`UPDATE forge_workflow_checkpoints SET checkpoint_epoch=$2,plan_hash=$3,input_fingerprint=$4,output_fingerprint=$5,provider_state_hash=$6,credential_state_hash=$7,admission_state_hash=$8,deadline_at=$9,validity='VALID',validated_at=now(),validated_by=$10,validation_hash=$11,schema_family=$12,schema_hash=$13,updated_at=now() WHERE id=$1 AND tenant_id=$14`,[checkpointId,envelope.checkpointEpoch,envelope.planHash,envelope.inputFingerprint,envelope.outputFingerprint,envelope.providerStateHash,envelope.credentialStateHash,envelope.admissionStateHash,envelope.deadlineAt,actor,validationHash,envelope.schemaFamily,envelope.schemaHash,tenantId]);
  return (await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
}

async function validateCheckpoint({pool, checkpointId, tenantId, actor='system', allowExpired=false}) {
  const cp=(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE id=$1 AND tenant_id=$2`,[checkpointId,tenantId])).rows[0];
  if(!cp) throw fail('CHECKPOINT_MISSING','Checkpoint not found',404);
  if(cp.validity==='QUARANTINED') throw fail('CHECKPOINT_QUARANTINED','Checkpoint is quarantined');
  const {envelope}=await buildEnvelope({pool,planId:cp.plan_id,tenantId,checkpoint:cp,actor});
  const mismatches=[];
  for(const key of ['templateVersionId','templateContentHash','schemaFamily','schemaVersion','schemaHash','planHash','inputFingerprint','outputFingerprint','providerStateHash','credentialStateHash','admissionStateHash','sideEffectBoundary']) {
    const column = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
    if(cp[column] != null && String(cp[column]) !== String(envelope[key])) mismatches.push(key);
  }
  if(cp.checkpoint_epoch != null && Number(cp.checkpoint_epoch)!==Number(envelope.checkpointEpoch)) mismatches.push('checkpointEpoch');
  if(cp.deadline_at && !allowExpired && new Date(cp.deadline_at).getTime() <= Date.now()) mismatches.push('deadlineExpired');
  if(hash(cp.safe_state)!==cp.state_hash) mismatches.push('stateHash');
  if(cp.validation_hash && cp.validation_hash!==hash({...envelope, actor:cp.validated_by||'system'})) mismatches.push('validationHash');
  const valid=mismatches.length===0;
  await pool.query(`INSERT INTO forge_workflow_checkpoint_diagnostics(checkpoint_id,tenant_id,plan_id,execution_epoch,outcome,reason,evidence,actor) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[cp.id,tenantId,cp.plan_id,cp.execution_epoch,valid?'VALID':'INVALID',valid?null:'Checkpoint compatibility or integrity validation failed',JSON.stringify({mismatches,current:{templateVersionId:envelope.templateVersionId,schemaHash:envelope.schemaHash,providerStateHash:envelope.providerStateHash,credentialStateHash:envelope.credentialStateHash,admissionStateHash:envelope.admissionStateHash}}),actor]);
  await pool.query(`UPDATE forge_workflow_checkpoints SET validity=$2,validated_at=now(),validated_by=$3,invalid_reason=$4 WHERE id=$1 AND tenant_id=$5`,[cp.id,valid?'VALID':'INVALID',actor,valid?null:mismatches.join(','),tenantId]);
  if(!valid) throw fail('CHECKPOINT_INVALID',`Checkpoint is not safely reusable: ${mismatches.join(',')}`);
  return {valid:true,checkpoint:cp,mismatches:[]};
}

async function quarantineCheckpoint({pool,checkpointId,tenantId,actor='operator',reason='operator quarantine'}) {
  const result=await pool.query(`UPDATE forge_workflow_checkpoints SET validity='QUARANTINED',invalid_reason=$3,validated_at=now(),validated_by=$4 WHERE id=$1 AND tenant_id=$2 RETURNING *`,[checkpointId,tenantId,reason,actor]);
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
  const id=randomUUID();
  const result=await pool.query(`INSERT INTO forge_workflow_reentry_attempts(id,checkpoint_id,tenant_id,plan_id,execution_epoch,requested_by,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'ADMITTED',$7) RETURNING *`,[id,checkpointId,tenantId,planId,control.execution_epoch,actor,idempotencyKey]);
  return result.rows[0];
}

module.exports={canonical,hash,buildEnvelope,sealCheckpoint,validateCheckpoint,quarantineCheckpoint,admitReentry};
