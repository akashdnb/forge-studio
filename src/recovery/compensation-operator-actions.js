'use strict';
const { randomUUID } = require('node:crypto');
async function manuallyCompleteCompensationStep({ pool, planId, stepId, tenantId, projectId, actor, evidence = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query(`SELECT s.*,p.tenant_id,p.project_id,p.status plan_status FROM forge_compensation_steps s JOIN forge_compensation_plans p ON p.id=s.plan_id WHERE s.id=$1 AND s.plan_id=$2 AND p.tenant_id=$3 AND p.project_id=$4 FOR UPDATE`,[stepId,planId,tenantId,projectId])).rows[0];
    if(!row)throw Object.assign(new Error('Compensation step not found in tenant scope'),{code:'NOT_FOUND'});
    if(row.status!=='QUARANTINED')throw Object.assign(new Error('Only quarantined compensation steps can be manually completed'),{code:'COMPENSATION_STATE_INVALID'});
    if(row.action_type!=='NON_COMPENSATABLE')throw Object.assign(new Error('Automatic compensation should be retried instead of manually completing this step'),{code:'COMPENSATION_STATE_INVALID'});
    const approval=(await client.query(`SELECT id FROM forge_compensation_approvals WHERE step_id=$1 AND tenant_id=$2 AND project_id=$3 AND status='APPROVED' AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1`,[stepId,tenantId,projectId])).rows[0];
    if(!approval)throw Object.assign(new Error('Valid owner approval is required'),{code:'COMPENSATION_APPROVAL_REQUIRED'});
    await client.query(`UPDATE forge_compensation_steps SET status='SUCCEEDED',lease_token=NULL,lease_until=NULL,last_error=NULL,finished_at=now() WHERE id=$1`,[stepId]);
    await client.query(`INSERT INTO forge_compensation_events(tenant_id,project_id,plan_id,step_id,event_type,actor,event_key,details) VALUES($1,$2,$3,$4,'MANUAL_COMPENSATION_COMPLETED',$5,$6,$7::jsonb) ON CONFLICT(event_key) DO NOTHING`,[tenantId,projectId,planId,stepId,actor,`manual-complete:${stepId}:${randomUUID()}`,JSON.stringify({approvalId:approval.id,evidence})]);
    const remaining=(await client.query(`SELECT count(*)::int count FROM forge_compensation_steps WHERE plan_id=$1 AND status NOT IN ('SUCCEEDED','SKIPPED','QUARANTINED')`,[planId])).rows[0].count;
    const quarantined=(await client.query(`SELECT count(*)::int count FROM forge_compensation_steps WHERE plan_id=$1 AND status='QUARANTINED'`,[planId])).rows[0].count;
    if(Number(quarantined)===0&&Number(remaining)===0)await client.query("UPDATE forge_compensation_plans SET status='COMPENSATED',finished_at=COALESCE(finished_at,now()) WHERE id=$1",[planId]);
    await client.query('COMMIT');
    return (await pool.query('SELECT * FROM forge_compensation_steps WHERE id=$1',[stepId])).rows[0];
  }catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
}
module.exports={manuallyCompleteCompensationStep};
