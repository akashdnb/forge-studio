'use strict';

const { NotificationOrchestrator } = require('./notification-orchestrator');
const { ProviderCircuitBreaker } = require('../providers/provider-circuit-breaker-runtime');

if (!ProviderCircuitBreaker.prototype.__forgeNotificationMetricsCompat) {
  const originalDeny = ProviderCircuitBreaker.prototype.deny;
  ProviderCircuitBreaker.prototype.deny = async function notificationMetricsCompat(db,row,scope,reason) {
    if (this.metrics && typeof this.metrics.increment !== 'function' && typeof this.metrics.inc === 'function') this.metrics.increment = (...args) => this.metrics.inc(...args);
    return originalDeny.call(this,db,row,scope,reason);
  };
  ProviderCircuitBreaker.prototype.__forgeNotificationMetricsCompat=true;
}

if (!NotificationOrchestrator.prototype.__forgeNotificationGuards) {
  const originalEnqueue=NotificationOrchestrator.prototype.enqueue;
  NotificationOrchestrator.prototype.enqueue=async function guardedEnqueue(args={}) {
    const intent=await originalEnqueue.call(this,args);
    const pending=await this.pool.query(`SELECT count(*)::int AS count FROM forge_notification_deliveries WHERE intent_id=$1`,[intent.id]);
    if(Number(pending.rows[0]?.count||0)===0){
      await this.pool.query(`UPDATE forge_notification_intents SET status='QUARANTINED',updated_at=now() WHERE id=$1 AND status IN ('QUEUED','SCHEDULED')`,[intent.id]);
      await this.pool.query(`INSERT INTO forge_notification_audit(tenant_id,project_id,intent_id,actor_id,action,outcome,evidence) VALUES($1,$2,$3,'notification-guard','QUARANTINE','NO_RECIPIENT',$4::jsonb)`,[intent.tenant_id,intent.project_id,intent.id,JSON.stringify({reason:'No enabled recipient preference or explicit recipient was supplied'})]);
    }
    return intent;
  };
  NotificationOrchestrator.prototype.claim=async function guardedClaim(limit=20){
    return this.tx(async c=>{
      const rows=(await c.query(`WITH candidates AS (SELECT d.id FROM forge_notification_deliveries d WHERE d.status IN ('QUEUED','RETRY') AND d.next_attempt_at<=now() AND(d.deadline_at IS NULL OR d.deadline_at>now()) AND NOT EXISTS(SELECT 1 FROM forge_notification_deliveries earlier WHERE earlier.intent_id=d.intent_id AND earlier.recipient_id=d.recipient_id AND earlier.status IN ('QUEUED','RETRY','LEASED') AND (earlier.priority<d.priority OR (earlier.priority=d.priority AND earlier.created_at<d.created_at))) ORDER BY d.priority,d.next_attempt_at,d.created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE forge_notification_deliveries d SET status='LEASED',attempt_count=d.attempt_count+1,lease_token=$2,fencing_token=d.fencing_token+1,lease_until=now()+interval '90 seconds',updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*`,[Math.max(1,Math.min(100,limit)),this.workerId])).rows;
      return rows;
    });
  };
  NotificationOrchestrator.prototype.nextFallback=async function guardedNextFallback(delivery){
    const sent=(await this.pool.query(`SELECT 1 FROM forge_notification_deliveries WHERE intent_id=$1 AND recipient_id=$2 AND status='SENT' LIMIT 1`,[delivery.intent_id,delivery.recipient_id])).rows[0];
    if(sent)return;
    const next=(await this.pool.query(`SELECT id FROM forge_notification_deliveries WHERE intent_id=$1 AND recipient_id=$2 AND status IN ('QUEUED','RETRY') AND id<>$3 ORDER BY priority,created_at LIMIT 1`,[delivery.intent_id,delivery.recipient_id,delivery.id])).rows[0];
    if(!next)return;
    await this.pool.query(`UPDATE forge_notification_deliveries SET status='CANCELLED',updated_at=now(),suppression_reason='fallback_not_selected' WHERE intent_id=$1 AND recipient_id=$2 AND status IN ('QUEUED','RETRY') AND id<>$3`,[delivery.intent_id,delivery.recipient_id,next.id]);
    await this.pool.query(`UPDATE forge_notification_deliveries SET status='RETRY',next_attempt_at=now(),updated_at=now() WHERE id=$1 AND status='QUEUED'`,[next.id]);
  };
  const originalDeliver=NotificationOrchestrator.prototype.deliver;
  NotificationOrchestrator.prototype.deliver=async function guardedDeliver(delivery) {
    const result=await originalDeliver.call(this,delivery);
    if(result?.sent===false&&result.error){
      const row=(await this.pool.query(`SELECT tenant_id,project_id,channel,idempotency_key FROM forge_notification_deliveries WHERE id=$1`,[delivery.id])).rows[0];
      if(row){const outcome=result.error.code==='PROVIDER_TIMEOUT'?'TIMEOUT':result.error.code==='RATE_LIMITED'?'RATE_LIMIT':result.error.code==='CIRCUIT_OPEN'?'FAILURE':result.error.code==='PROVIDER_FAILED'?'FAILURE':'NETWORK_FAILURE';await this.circuitBreaker.outcome({tenantId:row.tenant_id,projectId:row.project_id,provider:row.channel==='webhook'?'webhook-http':`notification.${row.channel}`,service:'notifications',capability:row.channel,operation:'notification.send',impactScope:'TENANT',region:process.env.FORGE_REGION||'',idempotencyKey:row.idempotency_key},{outcome,attemptId:row.idempotency_key,errorCode:result.error.code,eventId:`${row.idempotency_key}:${delivery.id}:${delivery.attempt_count}`,metadata:{notification:true}}).catch(()=>{});}
    }
    return result;
  };
  NotificationOrchestrator.prototype.__forgeNotificationGuards=true;
}

module.exports={};
