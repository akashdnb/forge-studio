'use strict';
const { IncidentManager } = require('./incident-manager');
function installIncidentConcurrencyBridge() {
  if (IncidentManager.prototype.__forgeIncidentConcurrencyBridge) return;
  IncidentManager.prototype.__forgeIncidentConcurrencyBridge = true;
  const original = IncidentManager.prototype.recordObservation;
  const originalEvaluate = IncidentManager.prototype.evaluateRule;
  IncidentManager.prototype.recordObservation = async function recordObservationWithRetry(args) {
    let result;
    try { result = await original.call(this, args); }
    catch (error) {
      if (error?.code !== '23505' && !/duplicate key value violates unique constraint "operational_incidents_active_fingerprint_uq"/.test(String(error?.message || ''))) throw error;
      result = await original.call(this, args);
    }
    if (result?.reopened) {
      return this.transition({ tenantId: args.tenantId, incidentId: result.incident.id, actorId: 'system', action: 'REOPEN', reason: 'Maintenance window or alert-rate suppression ended', idempotencyKey: `detector-reopen:${result.incident.id}:${new Date().toISOString().slice(0,13)}` }).then(item => ({ ...result, incident: item }));
    }
    return result;
  };
  IncidentManager.prototype.evaluateRule = async function evaluateRuleWithSafeScopes(tenantId, rule, limit) {
    if (rule.rule_key === 'dependency_blocked') {
      const result = await this.pool.query(`SELECT j.id source_id,j.project_id,j.episode_id,j.kind,j.status,j.blocked_reason FROM forge_jobs j LEFT JOIN forge_scheduler_events se ON se.job_id=j.id AND se.event_type='DEPENDENCY_FAILED' LEFT JOIN projects p ON p.id=j.project_id WHERE p.tenant_id=$1 AND j.status='QUEUED' AND j.blocked_reason IS NOT NULL AND (j.updated_at < now()-($2::text||' seconds')::interval OR se.created_at < now()-($2::text||' seconds')::interval) ORDER BY j.updated_at ASC LIMIT $3`, [tenantId, rule.threshold_seconds, limit]);
      return result.rows.map(row => ({ projectId: row.project_id, episodeId: row.episode_id, sourceType: 'job', sourceId: String(row.source_id), title: 'Job dependency blocked', summary: `${row.kind} remains blocked by scheduler dependency state`, evidence: { jobId: row.source_id, projectId: row.project_id, episodeId: row.episode_id, kind: row.kind, status: row.status } }));
    }
    if (rule.rule_key === 'artifact_corrupt') {
      const result = await this.pool.query(`SELECT a.id source_id,a.id artifact_id,a.episode_id,p.id project_id,l.state lifecycle_state,s.status storage_status FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id LEFT JOIN artifact_lifecycle_records l ON l.artifact_id=a.id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE p.tenant_id=$1 AND (l.state='QUARANTINED' OR s.status IN ('CORRUPT','MISSING')) ORDER BY COALESCE(l.updated_at,a.created_at) DESC LIMIT $2`, [tenantId, limit]);
      return result.rows.map(row => ({ projectId: row.project_id, episodeId: row.episode_id, sourceType: 'artifact', sourceId: String(row.source_id), title: 'Artifact integrity failure', summary: `Artifact ${row.artifact_id} is ${row.storage_status || row.lifecycle_state}`, evidence: { artifactId: row.artifact_id, projectId: row.project_id, episodeId: row.episode_id, state: row.storage_status || row.lifecycle_state } }));
    }
    if (rule.rule_key === 'reconciliation_drift') {
      const result = await this.pool.query(`SELECT rr.id source_id,rr.status,rr.repaired_count,rr.scanned_count,p.id project_id,rp.episode_id FROM forge_reconciliation_runs rr LEFT JOIN forge_reconciliation_repairs rp ON rp.run_id=rr.id LEFT JOIN episodes e ON e.id=rp.episode_id LEFT JOIN projects p ON p.id=e.project_id WHERE (p.tenant_id=$1 OR rr.diagnostics->>'tenantId'=$1) AND (rr.status='FAILED' OR (rr.status='SUCCEEDED' AND rr.repaired_count>0)) AND rr.started_at>now()-interval '30 minutes' GROUP BY rr.id,rr.status,rr.repaired_count,rr.scanned_count,p.id,rp.episode_id LIMIT $2`, [tenantId, limit]);
      return result.rows.map(row => ({ projectId: row.project_id, episodeId: row.episode_id, sourceType: 'reconciliation', sourceId: String(row.source_id), title: 'Reconciliation drift detected', summary: `Reconciliation run ${row.source_id} failed or repaired drift`, evidence: { reconciliationRunId: row.source_id, projectId: row.project_id, episodeId: row.episode_id, status: row.status, repairCount: row.repaired_count } }));
    }
    return originalEvaluate.call(this, tenantId, rule, limit);
  };
  if (!IncidentManager.prototype.resolve) {
    IncidentManager.prototype.resolve = async function resolve(id, actorId, reason, evidence = {}) {
      const row = (await this.pool.query('SELECT tenant_id FROM operational_incidents WHERE id=$1', [id])).rows[0];
      if (!row) return null;
      return this.transition({ tenantId: row.tenant_id, incidentId: id, actorId, action: 'RESOLVE', reason, resolutionEvidence: evidence, idempotencyKey: `detector-resolve:${id}:${new Date().toISOString().slice(0,13)}` });
    };
  }
}
module.exports = { installIncidentConcurrencyBridge };
