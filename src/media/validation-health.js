'use strict';

async function mediaValidationHealth(pool, { tenantId = null, projectId = null } = {}) {
  const scope = tenantId ? ' AND tenant_id=$1' : '';
  const params = tenantId ? [tenantId] : [];
  const status = await pool.query(`SELECT status,count(*)::int AS count FROM media_validation_records WHERE 1=1${scope} GROUP BY status`, params);
  const stale = await pool.query(`SELECT count(*)::int AS count FROM media_validation_records WHERE status='STALE' AND created_at>now()-interval '1 day'${scope}`, params);
  const quarantine = await pool.query(`SELECT count(*)::int AS count FROM media_quarantine WHERE status='OPEN'${scope}`, params);
  const projectFilter = projectId ? ' AND project_id=$2' : '';
  const projectParams = tenantId ? (projectId ? [tenantId, projectId] : [tenantId]) : (projectId ? [projectId] : []);
  const running = await pool.query(`SELECT count(*)::int AS count FROM media_validation_records WHERE status='RUNNING'${tenantId ? ' AND tenant_id=$1' : ''}${projectFilter}`, projectParams);
  return {
    ok: Number(stale.rows[0]?.count || 0) === 0,
    statuses: Object.fromEntries(status.rows.map((row) => [row.status, row.count])),
    stale24h: Number(stale.rows[0]?.count || 0),
    openQuarantine: Number(quarantine.rows[0]?.count || 0),
    running: Number(running.rows[0]?.count || 0),
  };
}

module.exports = { mediaValidationHealth };
