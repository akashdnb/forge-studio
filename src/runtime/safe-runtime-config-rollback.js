'use strict';
const { SafeRuntimeConfiguration } = require('./safe-runtime-configuration');
SafeRuntimeConfiguration.prototype.rollback = async function rollback({rolloutId,actor='system',reason='operator rollback'}={}) {
  const client=await this.pool.connect();
  try { await client.query('BEGIN');
    const rollout=(await client.query('SELECT * FROM forge_runtime_config_rollouts WHERE id=$1 FOR UPDATE',[rolloutId])).rows[0];
    if(!rollout)throw Object.assign(new Error('rollout not found'),{code:'NOT_FOUND',statusCode:404});
    const head=(await client.query('SELECT * FROM forge_runtime_config_heads WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 FOR UPDATE',[rollout.scope_type,rollout.scope_id,rollout.config_key])).rows[0];
    if(Number(head?.fence_epoch||0)!==Number(rollout.fence_epoch))throw Object.assign(new Error('rollout fence is stale'),{code:'STALE_CONFIG_FENCE',statusCode:409});
    if(rollout.previous_revision){
      await client.query("UPDATE forge_runtime_config_revisions SET state='ACTIVE',activated_at=COALESCE(activated_at,now()) WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 AND revision=$4",[rollout.scope_type,rollout.scope_id,rollout.config_key,rollout.previous_revision]);
      await client.query("UPDATE forge_runtime_config_revisions SET state='ROLLED_BACK',rollback_revision=$5 WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 AND revision=$4",[rollout.scope_type,rollout.scope_id,rollout.config_key,rollout.target_revision,rollout.previous_revision]);
      await client.query('UPDATE forge_runtime_config_heads SET current_revision=$4,generation=generation+1,fence_epoch=fence_epoch+1,updated_at=now() WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3',[rollout.scope_type,rollout.scope_id,rollout.config_key,rollout.previous_revision]);
    } else {
      await client.query('UPDATE forge_runtime_config_heads SET current_revision=NULL,generation=generation+1,fence_epoch=fence_epoch+1,updated_at=now() WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3',[rollout.scope_type,rollout.scope_id,rollout.config_key]);
      await client.query("UPDATE forge_runtime_config_revisions SET state='ROLLED_BACK' WHERE scope_type=$1 AND scope_id=$2 AND config_key=$3 AND revision=$4",[rollout.scope_type,rollout.scope_id,rollout.config_key,rollout.target_revision]);
    }
    await client.query("UPDATE forge_runtime_config_rollouts SET status='ROLLED_BACK',finished_at=now(),updated_at=now(),paused_reason=$2 WHERE id=$1",[rolloutId,reason]);
    await client.query("INSERT INTO forge_runtime_config_rollout_events(rollout_id,event_type,actor,from_status,to_status,reason) VALUES($1,'ROLLED_BACK',$2,$3,'ROLLED_BACK',$4)",[rolloutId,actor,rollout.status,reason]);
    await client.query('COMMIT'); this.invalidate(); return {ok:true,previousRevision:rollout.previous_revision};
  } catch(e){try{await client.query('ROLLBACK')}catch{}throw e} finally{client.release()}
};
module.exports=SafeRuntimeConfiguration;
