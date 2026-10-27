'use strict';

async function diagnostics(pool, tenantId) {
  const [bundles, decisions, denies] = await Promise.all([
    pool.query(`SELECT count(*)::int total, count(*) FILTER (WHERE state='ACTIVE')::int active, COALESCE(max(current_epoch),0)::bigint epoch FROM forge_policy_bundles WHERE tenant_id=$1`, [tenantId]),
    pool.query(`SELECT count(*)::int total, count(*) FILTER (WHERE decision='DENY')::int denied FROM forge_policy_decisions WHERE tenant_id=$1 AND created_at>now()-interval '24 hours'`, [tenantId]),
    pool.query(`SELECT count(*)::int active FROM forge_policy_emergency_denies WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>now()`, [tenantId])
  ]);
  const b=bundles.rows[0]||{}, d=decisions.rows[0]||{}, e=denies.rows[0]||{};
  return { healthy: Number(b.active||0)>0, tenantId, bundleCount:Number(b.total||0), activeBundleCount:Number(b.active||0), activationEpoch:Number(b.epoch||0), decisions24h:Number(d.total||0), denies24h:Number(d.denied||0), emergencyDenies:Number(e.active||0), failClosed:true, signingConfigured:Boolean(process.env.FORGE_POLICY_DECISION_SIGNING_SECRET) };
}

function runbook() {
  return { protectedDefault:'DENY', operatorOrder:['validate','dry-run/explain','create immutable version','activate bundle with expectedEpoch','observe decision metrics','rollback by previous activation epoch','emergency deny/revoke'], failureModes:{malformedPolicy:'reject before persistence',concurrentUpdate:'409 epoch/version conflict',staleCache:'activation epoch invalidates cached bundle',evaluationFailure:'fail closed; no protected operation proceeds',crossTenant:'403; subject/resource tenant must equal request tenant',replay:'decision evidence is immutable and tied to epoch/signature'}, requiredSecret:'FORGE_POLICY_DECISION_SIGNING_SECRET' };
}
module.exports={diagnostics,runbook};
