'use strict';

const crypto = require('node:crypto');

const DEFAULT_RULES = Object.freeze([
  ['stuck_job', 'WARNING', 900],
  ['lease_expired', 'ERROR', 0],
  ['retry_exhausted', 'ERROR', 0],
  ['dependency_blocked', 'WARNING', 900],
  ['provider_degraded', 'ERROR', 300],
  ['artifact_corrupt', 'CRITICAL', 0],
  ['budget_exhausted', 'ERROR', 0],
  ['runner_outage', 'CRITICAL', 300],
  ['reconciliation_drift', 'ERROR', 300],
  ['release_health_failure', 'CRITICAL', 0],
].map(([ruleKey, severity, thresholdSeconds]) => ({
  id: `default:${ruleKey}`,
  ruleKey,
  severity,
  thresholdSeconds,
  cooldownSeconds: 300,
  maxEventsPerWindow: 20,
  aggregationWindowSeconds: 300,
  escalationPolicy: [{ afterSeconds: 900, level: 1 }, { afterSeconds: 3600, level: 2 }],
}))); 

const SEVERITY_RANK = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fingerprint(ruleKey, projectId, sourceType, sourceId) { return hash([ruleKey, projectId || '*', sourceType, sourceId || '*'].join('|')); }
function groupFingerprint(ruleKey, projectId, sourceType) { return hash([ruleKey, projectId || '*', sourceType].join('|')); }
function safeText(value, fallback = 'Operational condition detected') {
  const text = String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 500) || fallback;
}
function safeEvidence(value) {
  if (!value || typeof value !== 'object') return {};
  const allowed = ['jobId','projectId','episodeId','kind','status','attempts','maxAttempts','workerId','leasedUntil','provider','failed','succeeded','failureRate','artifactId','state','budgetId','scopeType','scopeId','executionId','runnerStatus','lastHeartbeat','reconciliationRunId','repairCount','releaseId','phase','checkpointStatus'];
  return Object.fromEntries(allowed.filter(k => value[k] !== undefined && value[k] !== null).map(k => [k, typeof value[k] === 'string' ? safeText(value[k], '') : value[k]]));
}

class IncidentManager {
  constructor({ pool, logger = console, now = () => Date.now(), eventRateLimit = 20 } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.logger = logger;
    this.now = now;
    this.eventRateLimit = eventRateLimit;
  }

  async ensureRules(tenantId, actor = 'system') {
    if (!tenantId) return;
    for (const rule of DEFAULT_RULES) {
      await this.pool.query(`INSERT INTO incident_rules(id,tenant_id,rule_key,severity,threshold_seconds,cooldown_seconds,max_events_per_window,aggregation_window_seconds,escalation_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT(tenant_id,rule_key) DO NOTHING`, [hash(`${tenantId}:${rule.ruleKey}`).slice(0, 40), tenantId, rule.ruleKey, rule.severity, rule.thresholdSeconds, rule.cooldownSeconds, rule.maxEventsPerWindow, rule.aggregationWindowSeconds, JSON.stringify(rule.escalationPolicy), actor]);
    }
  }

  async listTenants() {
    return (await this.pool.query('SELECT id FROM tenants ORDER BY id')).rows.map(r => r.id);
  }

  async detect({ tenantId = null, limitPerRule = 50 } = {}) {
    const tenants = tenantId ? [tenantId] : await this.listTenants();
    let detected = 0;
    for (const tenant of tenants) {
      await this.ensureRules(tenant);
      const rules = (await this.pool.query('SELECT * FROM incident_rules WHERE tenant_id=$1 AND enabled=true ORDER BY rule_key', [tenant])).rows;
      for (const rule of rules) {
        try {
          const observations = await this.evaluateRule(tenant, rule, limitPerRule);
          for (const observation of observations) {
            const result = await this.recordObservation({ tenantId: tenant, rule, observation });
            if (result.created || result.reopened) detected += 1;
          }
        } catch (error) {
          this.logger.error?.({ event: 'incident.rule_failed', tenantId: tenant, ruleKey: rule.rule_key, message: error.message });
        }
      }
      await this.escalateTenant(tenant);
      await this.resolveCleared(tenant);
    }
    return { detected };
  }

  async evaluateRule(tenantId, rule, limit) {
    const r = rule.rule_key;
    const q = {
      stuck_job: [`SELECT j.id source_id,j.project_id,j.episode_id,j.kind,j.status,j.attempts,j.max_attempts,j.worker_id,j.leased_until FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='RUNNING' AND j.updated_at < now()-($2::text||' seconds')::interval ORDER BY j.updated_at ASC LIMIT $3`, [tenantId, rule.threshold_seconds, limit]],
      lease_expired: [`SELECT j.id source_id,j.project_id,j.episode_id,j.kind,j.status,j.attempts,j.max_attempts,j.worker_id,j.leased_until FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='RUNNING' AND j.leased_until IS NOT NULL AND j.leased_until<now() ORDER BY j.leased_until ASC LIMIT $2`, [tenantId, limit]],
      retry_exhausted: [`SELECT j.id source_id,j.project_id,j.episode_id,j.kind,j.status,j.attempts,j.max_attempts,j.error->>'code' error_code FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='FAILED' AND j.attempts>=j.max_attempts ORDER BY j.updated_at DESC LIMIT $2`, [tenantId, limit]],
      dependency_blocked: [`SELECT j.id source_id,j.project_id,j.episode_id,j.kind,j.status,j.blocked_reason,d.id dependency_id,d.status dependency_status FROM forge_jobs j LEFT JOIN forge_jobs d ON d.id=j.depends_on_job_id LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='QUEUED' AND (j.blocked_reason IS NOT NULL OR d.status IN ('FAILED','CANCELLED')) AND j.updated_at < now()-($2::text||' seconds')::interval ORDER BY j.updated_at ASC LIMIT $3`, [tenantId, rule.threshold_seconds, limit]],
      provider_degraded: [`SELECT pr.provider source_id,e.project_id,e.id episode_id,COUNT(*) FILTER(WHERE pr.status='FAILED')::int failed,COUNT(*) FILTER(WHERE pr.status='SUCCEEDED')::int succeeded,COUNT(*)::int total FROM provider_runs pr JOIN episodes e ON e.id=pr.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND pr.created_at>now()-interval '15 minutes' GROUP BY pr.provider,e.project_id,e.id HAVING COUNT(*)>=5 AND COUNT(*) FILTER(WHERE pr.status='FAILED')::numeric/COUNT(*)::numeric>=0.5 ORDER BY failed DESC LIMIT $2`, [tenantId, limit]],
      artifact_corrupt: [`SELECT a.id source_id,a.id artifact_id,a.episode_id,l.state,l.last_error FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE p.tenant_id=$1 AND l.state IN ('CORRUPT','MISSING','QUARANTINED') ORDER BY l.updated_at DESC LIMIT $2`, [tenantId, limit]],
      budget_exhausted: [`SELECT ub.id source_id,ub.scope_type,ub.scope_id,ub.state,p.id project_id FROM usage_budgets ub LEFT JOIN projects p ON ub.scope_type='PROJECT' AND p.id=ub.scope_id WHERE ub.state='EXHAUSTED' AND (p.tenant_id=$1 OR (ub.scope_type IN ('GLOBAL','PROVIDER') AND ub.metadata->>'tenantId'=$1)) ORDER BY ub.updated_at DESC LIMIT $2`, [tenantId, limit]],
      runner_outage: [`SELECT e.id source_id,e.project_id,e.job_id,e.status,e.runner_heartbeat_at,e.updated_at,e.tenant_key FROM forge_execution_runs e WHERE e.tenant_key=$1 AND e.status IN ('DISPATCHING','QUEUED','IN_PROGRESS') AND (e.runner_heartbeat_at IS NULL OR e.runner_heartbeat_at<now()-interval '2 minutes') ORDER BY e.updated_at ASC LIMIT $2`, [tenantId, limit]],
      reconciliation_drift: [`SELECT rr.id source_id,rr.status,rr.repaired_count,rr.scanned_count FROM forge_reconciliation_runs rr LEFT JOIN forge_reconciliation_repairs rp ON rp.run_id=rr.id WHERE rr.status='FAILED' OR (rr.status='SUCCEEDED' AND rr.repaired_count>0) GROUP BY rr.id HAVING MAX(rr.started_at)>now()-interval '30 minutes' LIMIT $2`, [limit]],
      release_health_failure: [`SELECT c.release_id source_id,c.release_id,c.phase,c.status checkpoint_status FROM forge_release_checkpoints c JOIN forge_release_manifests m ON m.release_id=c.release_id WHERE c.status IN ('FAILED','BLOCKED') AND c.created_at>now()-interval '30 minutes' ORDER BY c.created_at DESC LIMIT $2`, [limit]],
    };
    const entry = q[r];
    if (!entry) return [];
    let result;
    try { result = await this.pool.query(entry[0], entry[1]); } catch (error) {
      if (['budget_exhausted','runner_outage','reconciliation_drift','release_health_failure'].includes(r) && /relation .* does not exist/i.test(error.message)) return [];
      throw error;
    }
    return result.rows.map(row => {
      const projectId = row.project_id || null;
      const sourceId = String(row.source_id || row.id || `${r}:${projectId || tenantId}`);
      const sourceType = r === 'provider_degraded' ? 'provider' : r === 'budget_exhausted' ? 'budget' : r === 'runner_outage' ? 'runner' : r === 'release_health_failure' ? 'release' : r === 'reconciliation_drift' ? 'reconciliation' : r === 'artifact_corrupt' ? 'artifact' : 'job';
      const title = ({stuck_job:'Job stuck',lease_expired:'Worker lease expired',retry_exhausted:'Job retry budget exhausted',dependency_blocked:'Job dependency blocked',provider_degraded:'Provider degradation detected',artifact_corrupt:'Artifact integrity failure',budget_exhausted:'Budget exhausted',runner_outage:'Forge runner outage',reconciliation_drift:'Reconciliation drift detected',release_health_failure:'Release or migration health failure'})[r];
      const summary = ({stuck_job:`${row.kind} has not progressed within the configured threshold`,lease_expired:`${row.kind} is still running after its durable lease expired`,retry_exhausted:`${row.kind} reached ${row.attempts}/${row.max_attempts} attempts`,dependency_blocked:`${row.kind} remains blocked by an unhealthy dependency`,provider_degraded:`${row.source_id} has a sustained failure ratio above 50%`,artifact_corrupt:`Artifact ${row.artifact_id} is ${row.state}`,budget_exhausted:`${row.scope_type} budget ${row.scope_id} is exhausted`,runner_outage:`External Forge runner execution ${sourceId} has no recent heartbeat`,reconciliation_drift:`Reconciliation run ${sourceId} failed or repaired drift`,release_health_failure:`Release ${row.release_id} reported ${row.phase}=${row.checkpoint_status}`})[r];
      return { projectId, episodeId: row.episode_id || null, sourceType, sourceId, title, summary, evidence: safeEvidence(row) };
    });
  }

  async isSuppressed(tenantId, projectId, ruleKey) {
    const r = await this.pool.query(`SELECT id FROM incident_maintenance_windows WHERE tenant_id=$1 AND starts_at<=now() AND ends_at>now() AND (project_id IS NULL OR project_id=$2) AND (rule_key IS NULL OR rule_key=$3) LIMIT 1`, [tenantId, projectId, ruleKey]);
    return Boolean(r.rows[0]);
  }

  async allowRate(tenantId, groupKey, rule) {
    const windowMs = rule.aggregation_window_seconds * 1000;
    const bucket = new Date(Math.floor(this.now() / windowMs) * windowMs);
    const r = await this.pool.query(`INSERT INTO incident_rate_buckets(tenant_id,group_key,window_start,event_count) VALUES($1,$2,$3,1) ON CONFLICT(tenant_id,group_key,window_start) DO UPDATE SET event_count=incident_rate_buckets.event_count+1 RETURNING event_count`, [tenantId, groupKey, bucket]);
    return Number(r.rows[0].event_count) <= Math.min(rule.max_events_per_window, this.eventRateLimit);
  }

  async recordObservation({ tenantId, rule, observation }) {
    const fp = fingerprint(rule.rule_key, observation.projectId, observation.sourceType, observation.sourceId);
    const group = groupFingerprint(rule.rule_key, observation.projectId, observation.sourceType);
    const suppressed = await this.isSuppressed(tenantId, observation.projectId, rule.rule_key);
    const allowed = await this.allowRate(tenantId, group, rule);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query(`SELECT * FROM operational_incidents WHERE tenant_id=$1 AND fingerprint=$2 AND status IN ('OPEN','ACKNOWLEDGED','SUPPRESSED') FOR UPDATE`, [tenantId, fp]);
      let incident = active.rows[0];
      let created = false;
      if (incident) {
        await client.query(`UPDATE operational_incidents SET last_seen_at=now(),occurrence_count=occurrence_count+1,suppressed_count=suppressed_count+$3,summary=$4,evidence=$5::jsonb,updated_at=now() WHERE id=$1 AND tenant_id=$2`, [incident.id, tenantId, suppressed || !allowed ? 1 : 0, observation.summary, JSON.stringify(observation.evidence)]);
      } else {
        const id = `inc_${crypto.randomUUID()}`;
        const status = suppressed || !allowed ? 'SUPPRESSED' : 'OPEN';
        const next = this.nextEscalation(rule, 0);
        incident = (await client.query(`INSERT INTO operational_incidents(id,tenant_id,project_id,rule_key,fingerprint,group_key,severity,status,title,summary,source_type,source_id,evidence,next_escalation_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`, [id,tenantId,observation.projectId,rule.rule_key,fp,group,rule.severity,status,observation.title,observation.summary,observation.sourceType,observation.sourceId,JSON.stringify(observation.evidence),next])).rows[0];
        created = true;
      }
      await client.query(`INSERT INTO incident_occurrences(incident_id,tenant_id,project_id,fingerprint,source_id,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [incident.id,tenantId,observation.projectId,fp,observation.sourceId,JSON.stringify(observation.evidence)]);
      if (!suppressed && allowed && (created || incident.status === 'SUPPRESSED')) {
        await this.publishIncidentEvent(client, incident, created ? 'incident.created' : 'incident.unsuppressed', rule);
      }
      await client.query('COMMIT');
      return { incident, created, reopened: incident.status === 'SUPPRESSED' && !suppressed };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  nextEscalation(rule, currentLevel) {
    const policy = Array.isArray(rule.escalation_policy) ? rule.escalation_policy : [];
    const next = policy.find(x => Number(x.level) > currentLevel);
    if (!next) return null;
    const after = Math.max(1, Number(next.afterSeconds || 900));
    return new Date(this.now() + after * 1000);
  }

  async escalateTenant(tenantId) {
    const rows = (await this.pool.query(`SELECT i.*,r.escalation_policy FROM operational_incidents i JOIN incident_rules r ON r.tenant_id=i.tenant_id AND r.rule_key=i.rule_key WHERE i.tenant_id=$1 AND i.status IN ('OPEN','ACKNOWLEDGED') AND i.next_escalation_at IS NOT NULL AND i.next_escalation_at<=now() FOR UPDATE SKIP LOCKED`, [tenantId])).rows;
    for (const incident of rows) {
      const policy = Array.isArray(incident.escalation_policy) ? incident.escalation_policy : [];
      const next = policy.find(x => Number(x.level) > incident.current_escalation_level);
      if (!next) continue;
      const level = Number(next.level);
      const rule = { escalation_policy: policy };
      const nextAt = this.nextEscalation(rule, level);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const updated = (await client.query(`UPDATE operational_incidents SET current_escalation_level=$2,next_escalation_at=$3,last_notified_at=now(),updated_at=now() WHERE id=$1 AND current_escalation_level<$2 RETURNING *`, [incident.id, level, nextAt])).rows[0];
        if (updated) await this.publishIncidentEvent(client, updated, 'incident.escalated', rule);
        await client.query('COMMIT');
      } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    }
  }

  async resolveCleared(tenantId) {
    const stale = (await this.pool.query(`SELECT * FROM operational_incidents WHERE tenant_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') AND last_seen_at<now()-interval '30 minutes' ORDER BY last_seen_at ASC LIMIT 100`, [tenantId])).rows;
    for (const incident of stale) await this.resolve(incident.id, 'system', 'Condition cleared by detector after bounded observation window', { detector: true, lastSeenAt: incident.last_seen_at });
  }

  async publishIncidentEvent(client, incident, type, rule) {
    if (!incident.project_id) return null;
    const eventId = `inc_evt_${crypto.randomUUID()}`;
    const payload = {
      incidentId: incident.id,
      projectId: incident.project_id,
      ruleKey: incident.rule_key,
      severity: incident.severity,
      status: incident.status,
      title: safeText(incident.title),
      summary: safeText(incident.summary),
      sourceType: incident.source_type,
      sourceId: incident.source_id,
      escalationLevel: incident.current_escalation_level,
    };
    await client.query(`INSERT INTO forge_events(id,tenant_id,project_id,type,version,schema,payload,aggregate_type,aggregate_id,provenance) VALUES($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,'incident',$7,$8::jsonb)`, [eventId,incident.tenant_id,incident.project_id,type,JSON.stringify({version:1}),JSON.stringify(payload),incident.id,JSON.stringify({source:'incident-detector',rule:rule?.rule_key || incident.rule_key})]);
    await client.query(`INSERT INTO forge_outbox(topic,aggregate_type,aggregate_id,payload) VALUES('event.created','forge_event',$1,$2::jsonb)`, [eventId, JSON.stringify({eventId})]);
    await client.query(`INSERT INTO incident_notification_state(incident_id,tenant_id,last_event_id,last_level,last_sent_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(incident_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id,last_level=EXCLUDED.last_level,last_sent_at=now(),updated_at=now()`, [incident.id,incident.tenant_id,eventId,incident.current_escalation_level || 0]);
    return eventId;
  }

  async list({ tenantId, projectId = null, status = null, severity = null, limit = 50, offset = 0 } = {}) {
    const values = [tenantId]; const where = ['tenant_id=$1'];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (status) { values.push(status); where.push(`status=$${values.length}`); }
    if (severity) { values.push(severity); where.push(`severity=$${values.length}`); }
    values.push(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return (await this.pool.query(`SELECT id,tenant_id,project_id,rule_key,severity,status,title,summary,source_type,source_id,owner_id,acknowledged_at,acknowledged_by,resolved_at,resolved_by,first_seen_at,last_seen_at,occurrence_count,suppressed_count,current_escalation_level,next_escalation_at,last_notified_at,created_at,updated_at FROM operational_incidents WHERE ${where.join(' AND ')} ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,updated_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values)).rows;
  }

  async get(tenantId, id) {
    const incident = (await this.pool.query('SELECT * FROM operational_incidents WHERE tenant_id=$1 AND id=$2', [tenantId, id])).rows[0];
    if (!incident) return null;
    const [actions, occurrences] = await Promise.all([
      this.pool.query('SELECT action,actor_id,reason,evidence,created_at FROM incident_actions WHERE tenant_id=$1 AND incident_id=$2 ORDER BY created_at DESC LIMIT 100', [tenantId,id]),
      this.pool.query('SELECT observed_at,source_id,evidence FROM incident_occurrences WHERE tenant_id=$1 AND incident_id=$2 ORDER BY observed_at DESC LIMIT 100', [tenantId,id]),
    ]);
    return { ...incident, actions: actions.rows, occurrences: occurrences.rows };
  }

  async transition({ tenantId, incidentId, actorId, action, reason, ownerId = null, resolutionEvidence = {}, idempotencyKey = null }) {
    if (!reason || String(reason).trim().length < 8 || String(reason).length > 1000) throw Object.assign(new Error('reason must be 8..1000 characters'), { code: 'REASON_REQUIRED', statusCode: 400 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const incident = (await client.query('SELECT * FROM operational_incidents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, incidentId])).rows[0];
      if (!incident) throw Object.assign(new Error('Incident not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (idempotencyKey) {
        const prior = await client.query('SELECT * FROM incident_actions WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3', [tenantId,actorId,idempotencyKey]);
        if (prior.rows[0]) { await client.query('COMMIT'); return incident; }
      }
      const updates = { ACKNOWLEDGE: `status='ACKNOWLEDGED',acknowledged_at=now(),acknowledged_by=$3,owner_id=COALESCE($4,owner_id)`, ASSIGN: `owner_id=$4`, SUPPRESS: `status='SUPPRESSED',suppressed_count=suppressed_count+1`, UNSUPPRESS: `status='OPEN',last_seen_at=now()`, RESOLVE: `status='RESOLVED',resolved_at=now(),resolved_by=$3,resolution_evidence=$5::jsonb,next_escalation_at=NULL`, REOPEN: `status='OPEN',resolved_at=NULL,resolved_by=NULL,resolution_evidence='{}'::jsonb,next_escalation_at=now()`, ESCALATE: `current_escalation_level=current_escalation_level+1,next_escalation_at=NULL` };
      if (!updates[action]) throw Object.assign(new Error('Unsupported incident action'), { code: 'UNSUPPORTED_ACTION', statusCode: 400 });
      const updated = (await client.query(`UPDATE operational_incidents SET ${updates[action]},updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`, [incidentId,tenantId,actorId,ownerId,JSON.stringify(safeEvidence(resolutionEvidence))])).rows[0];
      await client.query(`INSERT INTO incident_actions(incident_id,tenant_id,project_id,actor_id,action,reason,evidence,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [incidentId,tenantId,incident.project_id,actorId,action,reason,JSON.stringify(safeEvidence(resolutionEvidence)),idempotencyKey]);
      await client.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,$3,$4,'operational_incident',$5,'ALLOWED',$6::jsonb)`, [tenantId,incident.project_id,actorId,`INCIDENT_${action}`,incidentId,JSON.stringify({reason: safeText(reason), evidence:safeEvidence(resolutionEvidence)})]);
      if (['ACKNOWLEDGE','RESOLVE','REOPEN','ESCALATE','UNSUPPRESS'].includes(action)) await this.publishIncidentEvent(client,updated,`incident.${action.toLowerCase()}`,{});
      await client.query('COMMIT');
      return updated;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async metrics({ tenantId = null } = {}) {
    const values = tenantId ? [tenantId] : []; const where = tenantId ? 'WHERE tenant_id=$1' : '';
    const active = await this.pool.query(`SELECT severity,COUNT(*)::int count FROM operational_incidents ${where} AND status IN ('OPEN','ACKNOWLEDGED') GROUP BY severity ORDER BY severity`, values);
    const notifications = await this.pool.query(`SELECT COUNT(*) FILTER(WHERE status IN ('PENDING','RETRY','IN_FLIGHT'))::int pending,COUNT(*) FILTER(WHERE status='DEAD_LETTER')::int dead_letter FROM forge_event_deliveries d ${tenantId ? 'WHERE d.tenant_id=$1' : ''}`, values);
    const latency = await this.pool.query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_seen_at-created_at))*1000),0)::bigint detection_latency_ms,COALESCE(AVG(EXTRACT(EPOCH FROM (last_notified_at-first_seen_at))*1000),0)::bigint notification_latency_ms FROM operational_incidents ${where}`, values);
    const suppressed = await this.pool.query(`SELECT COALESCE(SUM(suppressed_count),0)::int suppressed_events FROM operational_incidents ${where}`, values);
    const escalation = await this.pool.query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (now()-first_seen_at))),0)::bigint escalation_lag_seconds FROM operational_incidents ${where} AND current_escalation_level>0`, values);
    return { active: active.rows, notifications: notifications.rows[0], latency: latency.rows[0], suppressed: suppressed.rows[0], escalation: escalation.rows[0] };
  }
}

module.exports = { IncidentManager, DEFAULT_RULES, fingerprint, groupFingerprint, safeEvidence };
