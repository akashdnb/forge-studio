'use strict';
const { SafeRuntimeConfiguration } = require('./safe-runtime-configuration');

if (!SafeRuntimeConfiguration.prototype.transitionRollout) {
  SafeRuntimeConfiguration.prototype.transitionRollout = async function transitionRollout(rolloutId,toStatus,actor,reason='') {
    const allowed={PAUSED:['RUNNING'],RUNNING:['PAUSED','SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED']};
    const client=await this.pool.connect();
    try { await client.query('BEGIN');
      const row=(await client.query('SELECT * FROM forge_runtime_config_rollouts WHERE id=$1 FOR UPDATE',[rolloutId])).rows[0];
      if(!row)throw Object.assign(new Error('rollout not found'),{code:'NOT_FOUND',statusCode:404});
      if(!allowed[row.status]?.includes(toStatus))throw Object.assign(new Error(`invalid rollout transition ${row.status} -> ${toStatus}`),{code:'ROLLOUT_STATE_CONFLICT',statusCode:409});
      await client.query("UPDATE forge_runtime_config_rollouts SET status=$2,paused_reason=$3,updated_at=now(),finished_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED') THEN now() ELSE finished_at END WHERE id=$1",[rolloutId,toStatus,reason||null]);
      await client.query('INSERT INTO forge_runtime_config_rollout_events(rollout_id,event_type,actor,from_status,to_status,reason) VALUES($1,$2,$3,$4,$5,$6)',[rolloutId,`ROLLOUT_${toStatus}`,actor,row.status,toStatus,reason]);
      await client.query('COMMIT'); return {rolloutId,status:toStatus};
    } catch(e){try{await client.query('ROLLBACK')}catch{}throw e} finally{client.release()}
  };
  SafeRuntimeConfiguration.prototype.pause=async function pause({rolloutId,actor='system',reason='operator pause'}){return this.transitionRollout(rolloutId,'PAUSED',actor,reason)};
  SafeRuntimeConfiguration.prototype.resume=async function resume({rolloutId,actor='system'}){return this.transitionRollout(rolloutId,'RUNNING',actor,'operator resume')};
}
module.exports=SafeRuntimeConfiguration;
