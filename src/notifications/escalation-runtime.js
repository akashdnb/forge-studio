'use strict';

async function processEscalations({ orchestrator, limit = 50 } = {}) {
  const rows = await orchestrator.pool.query(`SELECT i.* FROM forge_notification_intents i WHERE i.status='PARTIAL' AND jsonb_typeof(i.escalation_policy)='array' AND jsonb_array_length(i.escalation_policy)>i.escalation_level AND NOT EXISTS(SELECT 1 FROM forge_notification_deliveries d WHERE d.intent_id=i.id AND d.status IN ('QUEUED','RETRY','LEASED')) ORDER BY i.updated_at LIMIT $1`,[Math.max(1,Math.min(200,limit))]);
  let escalated=0;
  for(const intent of rows.rows){
    const level=Number(intent.escalation_level||0)+1; const policy=intent.escalation_policy[level-1]||{}; const recipients=Array.isArray(policy.recipients)?policy.recipients:[]; if(!recipients.length)continue;
    try{
      await orchestrator.enqueue({tenantId:intent.tenant_id,projectId:intent.project_id,intentKey:`${intent.intent_key}:escalation:${level}`,dedupeKey:`${intent.dedupe_key}:escalation:${level}`,templateName:intent.template_name,templateVersion:intent.template_version,payload:{...intent.payload,escalationLevel:level},priority:Math.max(0,Number(intent.priority)-10),recipients,channels:Array.isArray(policy.channels)?policy.channels:[],scheduledAt:policy.delayMs?new Date(Date.now()+Number(policy.delayMs)):null,deadlineAt:intent.deadline_at,quietHours:intent.quiet_hours,escalationPolicy:intent.escalation_policy,createdBy:'notification-escalation'});
      await orchestrator.pool.query(`UPDATE forge_notification_intents SET escalation_level=$1,status='SCHEDULED',updated_at=now() WHERE id=$2 AND status='PARTIAL' AND escalation_level=$3`,[level,intent.id,level-1]); escalated++;
    }catch(error){orchestrator.logger.warn?.(JSON.stringify({event:'notification.escalation_failed',intentId:intent.id,level,code:error.code,message:error.message}));}
  }
  return {escalated};
}
module.exports={processEscalations};
