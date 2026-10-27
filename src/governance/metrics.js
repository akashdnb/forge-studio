'use strict';
async function quotaMetrics(pool){
 const [policies,reservations,buckets,usage,fairness]=await Promise.all([
  pool.query("SELECT count(*)::int value FROM forge_quota_policies WHERE active=true"),
  pool.query("SELECT status,count(*)::int value FROM forge_quota_reservations GROUP BY status"),
  pool.query("SELECT count(*)::int value FROM forge_quota_rate_buckets WHERE updated_at>now()-interval '15 minutes'"),
  pool.query("SELECT dimension,sum(amount)::numeric value FROM forge_quota_usage_events WHERE created_at>now()-interval '1 day' GROUP BY dimension ORDER BY dimension"),
  pool.query("SELECT count(*)::int value FROM forge_quota_fairness"),
 ]);
 const byStatus=Object.fromEntries(reservations.rows.map(r=>[r.status,Number(r.value)]));
 const lines=[
  `forge_quota_policies_active ${Number(policies.rows[0]?.value||0)}`,
  `forge_quota_reservations_held ${byStatus.HELD||0}`,
  `forge_quota_reservations_settled_total ${byStatus.SETTLED||0}`,
  `forge_quota_reservations_released_total ${byStatus.RELEASED||0}`,
  `forge_quota_reservations_expired_total ${byStatus.EXPIRED||0}`,
  `forge_quota_rate_buckets_active_15m ${Number(buckets.rows[0]?.value||0)}`,
  `forge_quota_fairness_tenants ${Number(fairness.rows[0]?.value||0)}`,
 ];
 for(const row of usage.rows)lines.push(`forge_quota_usage_24h{dimension="${String(row.dimension).replace(/[^a-z_]/g,'_')}"} ${Number(row.value||0)}`);
 return `${lines.join('\n')}\n`;
}
module.exports={quotaMetrics};
