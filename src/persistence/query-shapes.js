// Canonical SQL shapes used by the production DB hardening checks.
// Keep these shapes deterministic and bounded; callers should bind values.
const EPISODE_PAGE_SQL = `SELECT * FROM episodes
  WHERE ($1::text IS NULL OR project_id = $1)
    AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2, $3))
  ORDER BY updated_at DESC, id DESC
  LIMIT $4`;

const JOB_PAGE_SQL = `SELECT * FROM forge_jobs
  WHERE ($1::text IS NULL OR project_id = $1)
    AND ($2::text IS NULL OR episode_id = $2)
    AND ($3::text IS NULL OR status = $3)
    AND ($4::integer IS NULL OR (priority, created_at, id) > ($4, $5, $6))
  ORDER BY priority ASC, created_at ASC, id ASC
  LIMIT $7`;

const JOB_CLAIM_SQL = `WITH candidate AS (
  SELECT j.id FROM forge_jobs j
  WHERE j.status = 'QUEUED'
    AND j.available_at <= $1
    AND (j.leased_until IS NULL OR j.leased_until < $1)
    AND j.cancellation_requested_at IS NULL
  ORDER BY j.priority ASC, j.created_at ASC, j.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE forge_jobs j
SET status = 'RUNNING'
FROM candidate c
WHERE j.id = c.id
RETURNING j.*`;

const RETENTION_PAGE_SQL = `SELECT id FROM usage_events
  WHERE (created_at, id) < ($1, $2)
  ORDER BY created_at ASC, id ASC
  LIMIT $3`;

function assertBoundedQueryShape(sql, { allowOffset = false } = {}) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!/\blimit\s+(\$\d+|\d+)\b/.test(normalized)) throw new Error('Critical query must have a bound LIMIT');
  if (!allowOffset && /\boffset\s+\$\d+\b/.test(normalized)) throw new Error('Critical query must use keyset pagination, not OFFSET');
  return true;
}

module.exports = { EPISODE_PAGE_SQL, JOB_PAGE_SQL, JOB_CLAIM_SQL, RETENTION_PAGE_SQL, assertBoundedQueryShape };
