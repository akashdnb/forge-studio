const { buildDiff: buildBaseDiff, sha, canonical } = require('./version-diff');

async function buildDiff(options = {}) {
  const report = await buildBaseDiff(options);
  const { pool } = options;
  const ids = [...new Set([report.sourceVersionId, report.targetVersionId, ...(report.sourceGraph || []).map((x) => x.id), ...(report.targetGraph || []).map((x) => x.id)])];
  const [workflowStages, workflowRuns, configJobs, budgets, reservations] = await Promise.all([
    pool.query(`SELECT s.workflow_id,s.stage,s.status,s.input_version_ids,s.output_version_ids,s.output_artifact_ids,s.error,s.started_at,s.finished_at FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND (s.input_version_ids ?| $2::text[] OR s.output_version_ids ?| $2::text[]) ORDER BY s.workflow_id,s.stage`, [report.episodeId, ids]),
    pool.query('SELECT id,status,current_stage,last_safe_stage,failure_stage,failure,requested_stages,created_at,updated_at FROM episode_workflows WHERE episode_id=$1 ORDER BY created_at,id', [report.episodeId]),
    pool.query('SELECT id,kind,runtime_snapshot_hash,runtime_policy_versions,created_at FROM forge_jobs WHERE episode_id=$1 AND runtime_snapshot IS NOT NULL ORDER BY created_at,id LIMIT 500', [report.episodeId]),
    pool.query(`SELECT id,scope_type,scope_id,period_key,hard_cost_limit,hard_usage_limit,soft_cost_limit,soft_usage_limit,currency,state,config_version,metadata,updated_at FROM usage_budgets WHERE (scope_type='EPISODE' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2) ORDER BY id`, [report.episodeId, report.projectId]),
    pool.query('SELECT id,job_id,provider_type,provider,model,operation,attempt,estimated_units,estimated_cost,currency,status,expires_at,created_at,settled_at FROM usage_reservations WHERE episode_id=$1 ORDER BY id', [report.episodeId])
  ]);
  const evidence = { workflowStages: workflowStages.rows, workflowRuns: workflowRuns.rows, configurationSnapshots: configJobs.rows, budgets: budgets.rows, reservations: reservations.rows };
  const items = [...report.items];
  const add = (category, path, before, after, identity) => {
    if (canonical(before) === canonical(after)) return;
    const id = sha({ category, path, identity, before, after });
    items.push({ id: id.slice(0, 32), category, path, changeType: before == null ? 'ADDED' : after == null ? 'REMOVED' : 'CHANGED', sourceId: identity, targetId: identity, before, after, evidence: { sourceVersionId: report.sourceVersionId, targetVersionId: report.targetVersionId } });
  };
  for (const row of evidence.workflowStages) add('workflow-stage', `${row.workflow_id}:${row.stage}`, null, row, `${row.workflow_id}:${row.stage}`);
  for (const row of evidence.workflowRuns) add('workflow-state', row.id, null, { status: row.status, currentStage: row.current_stage, lastSafeStage: row.last_safe_stage, failureStage: row.failure_stage }, row.id);
  for (const row of evidence.configurationSnapshots) add('configuration', `job/${row.id}`, null, row, row.id);
  for (const row of evidence.budgets) add('budget', `budget/${row.id}`, null, row, String(row.id));
  for (const row of evidence.reservations) add('usage-reservation', `reservation/${row.id}`, null, row, row.id);
  items.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || a.changeType.localeCompare(b.changeType) || a.id.localeCompare(b.id));
  const enriched = { ...report, items, evidence: { ...(report.evidence || {}), ...evidence }, summary: { total: items.length, added: items.filter((x) => x.changeType === 'ADDED').length, removed: items.filter((x) => x.changeType === 'REMOVED').length, changed: items.filter((x) => x.changeType === 'CHANGED').length } };
  delete enriched.reportHash;
  enriched.reportHash = sha(enriched);
  return enriched;
}
module.exports = { buildDiff };
