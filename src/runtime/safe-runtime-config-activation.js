'use strict';
const { SafeRuntimeConfiguration } = require('./safe-runtime-configuration');
SafeRuntimeConfiguration.prototype.activate = async function activate({scopeType,scopeId,configKey,revision,actor='system',rolloutPercent=null,rolloutCohort=null,auth=null,tenantId=null,projectId=null,emergency=false}) {
  const client=await this.pool.connect();
  try { await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`forge-config-activate:${scopeType}:${scopeId}:${configKey}`]);
    const row=(await client.query('SELECT * FROM forge_runtime_config_revisions WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 AND revision=$4 FOR UPDATE',[scopeType,scopeId,configKey,revision])).rows[0];
    if(!row)throw Object.assign(new Error('configuration revision not found'),{code:'NOT_FOUND',statusCode:404});
    if(!['STAGED','PAUSED'].includes(row.state))throw Object.assign(new Error(`configuration revision is ${row.state}`),{code:'CONFIG_STATE_CONFLICT',statusCode:409});
    const head=(await client.query('SELECT * FROM forge_runtime_config_heads WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 FOR UPDATE',[scopeType,scopeId,configKey])).rows[0];
    const previous=Number(head?.current_revision||0)||null; const nextPercent=rolloutPercent===null?Number(row.rollout_percent):Number(rolloutPercent); const nextCohort=rolloutCohort||row.rollout_cohort;
    const generation=Number(head?.generation||0)+1; const fenceEpoch=Number(head?.fence_epoch||0)+1;
    await client.query("UPDATE forge_runtime_config_revisions SET state='ACTIVE',previous_revision=$5,rollout_percent=$6,rollout_cohort=$7,activated_at=COALESCE(activated_at,now()),fence_epoch=$8 WHERE id=$1",[row.id,scopeType,scopeId,configKey,previous,nextPercent,nextCohort,fenceEpoch]);
    await client.query(`INSERT INTO forge_runtime_config_heads(scope_type,scope_id,config_key,current_revision,generation,fence_epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_type,scope_id,config_key) DO UPDATE SET current_revision=EXCLUDED.current_revision,generation=EXCLUDED.generation,fence_epoch=EXCLUDED.fence_epoch,updated_at=now(),kill_switch=false`,[scopeType,scopeId,configKey,revision,generation,fenceEpoch]);
    if(previous && nextPercent>=100) await client.query("UPDATE forge_runtime_config_revisions SET state='RETIRED',retired_at=now() WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 AND revision=$4 AND state='ACTIVE'",[scopeType,scopeId,configKey,previous]);
    const rollout=(await client.query(`INSERT INTO forge_runtime_config_rollouts(scope_type,scope_id,config_key,target_revision,previous_revision,status,rollout_percent,cohort,deterministic_seed,actor,fence_epoch,started_at) VALUES($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,$9,$10,now()) RETURNING *`,[scopeType,scopeId,configKey,revision,previous,nextPercent,nextCohort,`${configKey}:${revision}:${fenceEpoch}`,actor,fenceEpoch])).rows[0];
    await client.query('INSERT INTO forge_runtime_config_rollout_events(rollout_id,event_type,actor,from_status,to_status,from_percent,to_percent) VALUES($1,\'ACTIVATED\',$2,\'STAGED\',\'RUNNING\',$3,$4)',[rollout.id,actor,previous?100:0,nextPercent]);
    await client.query('COMMIT'); this.invalidate(); await this.audit({tenantId,projectId,actor,action:emergency?'EMERGENCY_ACTIVATE':'REVISION_ACTIVATED',configKey,scopeType,scopeId,revision,rolloutId:rollout.id,details:{previousRevision:previous,generation,fenceEpoch,rolloutPercent:nextPercent,rolloutCohort:nextCohort}}); return {revision,generation,fenceEpoch,rollout};
  } catch(e){try{await client.query('ROLLBACK')}catch{}throw e} finally{client.release()}
};
module.exports=SafeRuntimeConfiguration;
