async function health(pool) {
  const result = await pool.query(`SELECT
    count(*) FILTER (WHERE status='IN_PROGRESS')::int AS in_progress,
    count(*) FILTER (WHERE status='COMMITTED')::int AS committed,
    count(*) FILTER (WHERE status='EXPIRED')::int AS expired,
    count(*) FILTER (WHERE expires_at < now())::int AS expired_rows,
    min(expires_at) FILTER (WHERE status='IN_PROGRESS') AS oldest_in_progress
  FROM forge_api_idempotency_keys`);
  const row = result.rows[0] || {};
  return {
    status: Number(row.in_progress || 0) > 0 && row.oldest_in_progress && new Date(row.oldest_in_progress).getTime() < Date.now() - 15 * 60 * 1000 ? 'degraded' : 'ok',
    counts: {
      inProgress: Number(row.in_progress || 0),
      committed: Number(row.committed || 0),
      expired: Number(row.expired || 0),
      expiredRows: Number(row.expired_rows || 0),
    },
    oldestInProgress: row.oldest_in_progress || null,
  };
}

async function metrics(pool, { sinceSeconds = 3600 } = {}) {
  if (!Number.isInteger(sinceSeconds) || sinceSeconds < 60 || sinceSeconds > 7 * 24 * 60 * 60) throw new TypeError('sinceSeconds must be between 60 and 604800');
  const result = await pool.query(`SELECT operation,event_type,count(*)::int AS count
    FROM forge_api_idempotency_events
    WHERE created_at >= now()-($1::text||' seconds')::interval
    GROUP BY operation,event_type
    ORDER BY operation,event_type`, [sinceSeconds]);
  return result.rows;
}

async function replayConflicts(pool, { sinceSeconds = 3600, limit = 100 } = {}) {
  const result = await pool.query(`SELECT tenant_id,project_id,operation,idempotency_key,request_hash,actor,request_id,details,created_at
    FROM forge_api_idempotency_events
    WHERE event_type='CONFLICT'
      AND created_at >= now()-($1::text||' seconds')::interval
    ORDER BY created_at DESC LIMIT $2`, [sinceSeconds, Math.min(500, Math.max(1, limit))]);
  return result.rows;
}

module.exports = { health, metrics, replayConflicts };
