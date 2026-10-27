const { Pool } = require('pg');
const REQUIRED_INDEXES = ['forge_jobs_claim_hot_idx','forge_jobs_dependency_status_idx','forge_jobs_running_lease_idx','episodes_project_updated_id_idx','episodes_global_updated_id_idx','version_dependencies_dependency_version_idx','artifacts_episode_version_kind_created_idx','qa_results_passing_latest_idx','usage_events_retention_idx','usage_reservations_expiry_hot_idx','artifact_lifecycle_candidate_hot_idx'];
function collectPlanNodes(plan, out = []) { if (!plan) return out; if (plan['Node Type']) out.push(plan); for (const child of plan.Plans || []) collectPlanNodes(child, out); return out; }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); const client = await pool.connect();
  try {
    const missing = await client.query(`SELECT expected.name FROM unnest($1::text[]) AS expected(name) LEFT JOIN pg_indexes i ON i.schemaname='public' AND i.indexname=expected.name WHERE i.indexname IS NULL`, [REQUIRED_INDEXES]);
    if (missing.rowCount) throw new Error(`Missing hardening indexes: ${missing.rows.map((r) => r.name).join(', ')}`);
    const jobs = await client.query(`SELECT count(*)::int AS count FROM forge_jobs j JOIN episodes e ON e.id=j.episode_id WHERE j.episode_id IS NOT NULL AND j.project_id <> e.project_id`);
    if (jobs.rows[0].count !== 0) throw new Error('forge_jobs ownership invariant violated');
    const artifacts = await client.query(`SELECT count(*)::int AS count FROM artifacts a LEFT JOIN version_records v ON v.id=a.version_id WHERE v.id IS NULL OR a.episode_id <> v.episode_id`);
    if (artifacts.rows[0].count !== 0) throw new Error('artifact/version provenance invariant violated');
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan=off');
      const plans = [
        await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM episodes WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT 50`, ['__verify__']),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM forge_jobs WHERE status='QUEUED' AND cancellation_requested_at IS NULL ORDER BY priority, created_at, id LIMIT 1`),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM usage_events WHERE (created_at,id)<($1,$2) ORDER BY created_at,id LIMIT 100`, [new Date(), '__verify__']),
      ];
      for (const result of plans) { const nodes = collectPlanNodes(result.rows[0]['QUERY PLAN'][0].Plan); if (!nodes.some((node) => /Index Scan|Index Only Scan|Bitmap Index Scan/.test(node['Node Type']))) throw new Error(`Expected index-capable EXPLAIN plan, got: ${nodes.map((n) => n['Node Type']).join(', ')}`); }
    } finally { await client.query('ROLLBACK'); }
    console.log(JSON.stringify({ status: 'ok', indexes: REQUIRED_INDEXES.length, explainChecks: 3, integrityChecks: 2 }));
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { console.error(`Database hardening verification failed: ${error.message}`); process.exitCode = 1; });
