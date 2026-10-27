const { buildDiff: buildBaseDiff, sha, canonical } = require('./version-diff');

async function buildDiff(options = {}) {
  const report = await buildBaseDiff(options);
  const { pool } = options;
  const ids = [...new Set([...report.sourceVersionId, ...report.targetVersionId, ...(report.sourceGraph || []).map((x) => x.id), ...(report.targetGraph || []).map((x) => x.id)])];
  const [workflowStages, workflowRuns, configJobs, budgets, reservations] = await Promise.all([
    pool.query(`SELECT s.workflow_id,s.stage,s.status,s.input_version_ids,s.output_version_ids,s.output_artifact_ids,s.error,s.started_at,s.finished_at FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND (s.input_version_ids ?| $2::text[] OR s.output_version_ids ?| $2::text[]) ORDER BY s.workflow_id,s.stage`, [report.episodeId, ids]),
    pool.query('SELECT id,status,current_stage,last_safe_stage,failure_stage,failure,requested_stages,created_at,updated_at FROM episode_workflows WHERE episode_id=$1 ORDER BY created_at,id', [report.episodeId]),
    pool.query('SELECT id,kind,runtime_snapshot,runtime_snapshot_hash,runtime_policy_versions,created_at FROM forge_jobs WHERE episode_id=$1 AND runtime_snapshot IS NOT NULL ORDER BY created_at,id LIMIT 500', [report.episodeId]),
    pool.query('SELECT id,project_id,episode_id,scope_type,scope_id,period_start,period_end,limit_units,limit_cost,used_units,used_cost,state,metadata,updated_at FROM usage_budgets WHERE episode_id=$1 OR project_id=$2 ORDER BY id', [report.episodeId, report.projectId]),
    pool.query('SELECT id,job_id,provider,estimated_cost,reserved_cost,status,expires_at,created_at,settled_at,metadata FROM usage_reservations WHERE job_id IN (SELECT id FROM forge_jobs WHERE episode_id=$1) ORDER BY id', [report.episodeId])
  ]);
  const evidence = { workflowStages: workflowStages.rows, workflowRuns: workflowRuns.rows, configurationSnapshots: configJobs.rows, budgets: budgets.rows, reservations: reservations.rows };
  const items = [...report.items];
  const add = (category, path, before, after, identity) => {
    if (canonical(before) === canonical(after)) return;
    const id = sha({ category, path, identity, before, after });
    items.push({ id: id.slice(0, 32), category, path, changeType: before == null ? 'ADDED' : after == null ? 'REMOVED' : 'CHANGED', sourceId: identity, targetId: identity, before, after, evidence: { sourceVersionId: report.sourceVersionId, targetVersionId: report.targetVersionId } });
  };
  const stageByKey = (rows) => new Map(rows.map((x) => [`${x.workflow_id}:${x.stage}`, x]));
  const stages = stageByKey(evidence.workflowStages);
  for (const [key, value] of stages) add('workflow-stage', key, null, value, key);
  const runByStage = new Map(evidence.workflowRuns.map((x) => [x.id, x]));
  for (const row of evidence.workflowStages) { const run = runByStage.get(row.workflow_id); if (run) add('workflow-state', row.workflow_id, null, { status: run.status, currentStage: run.current_stage, lastSafeStage: run.last_safe_stage, failureStage: run.failure_stage }, row.workflow_id); }
  const configs = evidence.configurationSnapshots.map((x) => ({ id: x.id, kind: x.kind, runtimeSnapshotHash: x.runtime_snapshot_hash, runtimePolicyVersions: x.runtime_policy_versions }));
  for (const config of configs) add('configuration', `job/${config.id}`, null, config, config.id);
  for (const budget of evidence.budgets) add('budget', `budget/${budget.id}`, null, budget, budget.id);
  for (const reservation of evidence.reservations) add('usage-reservation', `reservation/${reservation.id}`, null, reservation, reservation.id);
  items.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || a.changeType.localeCompare(b.changeType) || a.id.localeCompare(b.id));
  const enriched = { ...report, items, evidence: { ...(report.evidence || {}), ...evidence }, summary: { total: items.length, added: items.filter((x) => x.changeType === 'ADDED').length, removed: items.filter((x) => x.changeType === 'REMOVED').length, changed: items.filter((x) => x.changeType === 'CHANGED').length } };
  delete enriched.reportHash;
  enriched.reportHash = sha(enriched);
  return enriched;
}
module.exports = { buildDiff };
