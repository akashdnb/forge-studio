'use strict';

const { createHash, randomUUID } = require('node:crypto');

const STAGE_ORDER = Object.freeze([
  'RESEARCH','SCRIPT','SCENE_PLAN','NARRATION','TRANSCRIPTION','ASSETS','TIMELINE','CAPTIONS','RENDER','QA','PACKAGING','PUBLISH',
]);
const PROVIDER_COMPENSATABLE = new Set(['RESEARCH','SCRIPT','SCENE_PLAN','NARRATION','ASSETS','TIMELINE']);
const TERMINAL_STEP = new Set(['SUCCEEDED','SKIPPED','QUARANTINED']);
const BACKOFF_MAX_SECONDS = 300;

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function safeError(error) { return { code: error?.code || 'COMPENSATION_FAILED', message: error?.message || String(error), retryable: error?.retryable !== false }; }
function compensationEndpoint(stage) { return process.env[`FORGE_COMPENSATION_${stage}_ENDPOINT`] || null; }

function actionForStage(stage) {
  if (stage === 'PUBLISH') return { actionType: 'CANCEL_PUBLISH', reversible: true, requiresApproval: false };
  if (stage === 'TRANSCRIPTION' || stage === 'CAPTIONS' || stage === 'RENDER' || stage === 'PACKAGING') return { actionType: 'QUARANTINE_ARTIFACT', reversible: true, requiresApproval: false };
  if (stage === 'QA') return { actionType: 'NON_COMPENSATABLE', reversible: false, requiresApproval: true };
  if (PROVIDER_COMPENSATABLE.has(stage)) {
    const endpoint = compensationEndpoint(stage);
    if (endpoint) return { actionType: 'PROVIDER_HTTP', reversible: true, requiresApproval: false, endpoint };
  }
  return { actionType: 'NON_COMPENSATABLE', reversible: false, requiresApproval: true };
}

class CompensationSagaService {
  constructor({ pool, fetchImpl = fetch, logger = console, leaseSeconds = 120, maxAttempts = 5, now = () => new Date() } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    this.pool = pool; this.fetchImpl = fetchImpl; this.logger = logger; this.leaseSeconds = leaseSeconds; this.maxAttempts = maxAttempts; this.now = now;
  }

  async ensurePlan({ workflowId, actor = 'workflow', trigger = null, triggerReason = {} } = {}) {
    const workflow = (await this.pool.query(`SELECT w.*,p.tenant_id FROM episode_workflows w JOIN projects p ON p.id=w.project_id WHERE w.id=$1`, [workflowId])).rows[0];
    if (!workflow) throw Object.assign(new Error('Workflow not found'), { code: 'NOT_FOUND' });
    const snapshot = { workflowId: workflow.id, episodeId: workflow.episode_id, projectId: workflow.project_id, tenantId: workflow.tenant_id, brief: workflow.brief, requestedStages: workflow.requested_stages };
    const workflowVersionHash = hash(snapshot);
    const planHash = hash({ workflowVersionHash, stages: workflow.requested_stages });
    const planId = `cplan:${workflow.id}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM forge_compensation_plans WHERE id=$1 FOR UPDATE', [planId]);
      if (!existing.rows[0]) {
        await client.query(`INSERT INTO forge_compensation_plans(id,tenant_id,project_id,workflow_id,workflow_version_hash,plan_hash,status,trigger,trigger_reason,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8::jsonb,$9)`, [planId, workflow.tenant_id, workflow.project_id, workflow.id, workflowVersionHash, planHash, trigger, JSON.stringify(triggerReason), actor]);
        let sequence = workflow.requested_stages.length;
        for (const stage of workflow.requested_stages) {
          const spec = actionForStage(stage);
          const stepId = `cstep:${workflow.id}:${stage}`;
          await client.query(`INSERT INTO forge_compensation_steps(id,plan_id,sequence_no,stage,action_type,reversible,requires_approval,max_attempts,idempotency_key,compensation_spec)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [stepId, planId, sequence--, stage, spec.actionType, spec.reversible, spec.requiresApproval, this.maxAttempts, `compensate:${workflow.id}:${stage}`, JSON.stringify(spec)]);
        }
        await this.#event(client, { workflow, planId, eventType: 'PLAN_CREATED', actor, eventKey: `plan-created:${planId}`, details: { workflowVersionHash, planHash } });
      } else if (existing.rows[0].workflow_version_hash !== workflowVersionHash) {
        throw Object.assign(new Error('Workflow version changed after compensation plan creation'), { code: 'COMPENSATION_PLAN_IMMUTABLE' });
      }
      if (trigger && existing.rows[0]?.status === 'ACTIVE') await client.query(`UPDATE forge_compensation_plans SET trigger=COALESCE(trigger,$2),trigger_reason=CASE WHEN trigger IS NULL THEN $3::jsonb ELSE trigger_reason END WHERE id=$1`, [planId, trigger, JSON.stringify(triggerReason)]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    return this.getPlan(planId, workflow.tenant_id);
  }

  async recordForwardSideEffect({ job, result = {}, reservation = null } = {}) {
    const workflowId = job?.payload?.workflowId;
    const stage = String(job?.payload?.stage || '').toUpperCase();
    if (!workflowId || !STAGE_ORDER.includes(stage)) return null;
    const plan = await this.ensurePlan({ workflowId, actor: job.payload.actor || job.created_by || 'worker' });
    const step = (await this.pool.query('SELECT * FROM forge_compensation_steps WHERE plan_id=$1 AND stage=$2', [plan.id, stage])).rows[0];
    if (!step) return null;
    const outputVersionIds = result.versionId ? [result.versionId] : Array.isArray(result.outputVersionIds) ? result.outputVersionIds : [];
    const artifactIds = result.artifactId ? [result.artifactId] : Array.isArray(result.outputArtifactIds) ? result.outputArtifactIds : [];
    const providerRunId = result.providerRunId || result.provider_run_id || null;
    const externalReference = stage === 'PUBLISH' ? (result.publishRunId || job.payload.publishRunId || null) : providerRunId;
    const effect = { planId: plan.id, stepId: step.id, jobId: job.id, attempt: Number(job.attempts) || 1, stage, outputVersionIds, artifactIds, providerRunId, externalReference, reservationId: reservation?.id || null };
    const fingerprint = hash(effect);
    const id = `effect:${fingerprint}`;
    await this.pool.query(`INSERT INTO forge_compensation_side_effects(id,tenant_id,project_id,plan_id,step_id,job_id,attempt,effect_type,external_reference,input_version_ids,output_version_ids,artifact_ids,provider_run_id,effect_fingerprint,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb) ON CONFLICT(effect_fingerprint) DO NOTHING`,
      [id, plan.tenant_id, plan.project_id, plan.id, step.id, job.id, Number(job.attempts) || 1, `FORWARD_${stage}`, externalReference, JSON.stringify(job.payload.inputVersionIds || []), JSON.stringify(outputVersionIds), JSON.stringify(artifactIds), providerRunId, fingerprint, JSON.stringify({ provider: result.provider || null, reservationId: reservation?.id || null, resultMetadata: result.metadata || {} })]);
    return { id, planId: plan.id, stepId: step.id, fingerprint };
  }

  async triggerForWorkflow({ workflowId, actor = 'recovery', trigger = 'FAILURE', reason = {} } = {}) {
    const plan = await this.ensurePlan({ workflowId, actor, trigger, triggerReason: reason });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT * FROM forge_compensation_plans WHERE id=$1 FOR UPDATE', [plan.id])).rows[0];
      if (!locked) throw Object.assign(new Error('Compensation plan not found'), { code: 'NOT_FOUND' });
      if (['COMPENSATED','CANCELLED'].includes(locked.status)) { await client.query('COMMIT'); return this.getPlan(locked.id, locked.tenant_id); }
      await client.query(`UPDATE forge_compensation_plans SET status='COMPENSATING',started_at=COALESCE(started_at,now()),trigger=COALESCE(trigger,$2),trigger_reason=CASE WHEN trigger_reason='{}'::jsonb THEN $3::jsonb ELSE trigger_reason END WHERE id=$1`, [locked.id, trigger, JSON.stringify(reason)]);
      await client.query(`UPDATE forge_compensation_steps s SET available_at=now(),status='PENDING' WHERE s.plan_id=$1 AND s.status IN ('PENDING','FAILED') AND EXISTS(SELECT 1 FROM forge_compensation_side_effects e WHERE e.step_id=s.id)`, [locked.id]);
      await this.#event(client, { workflow: { tenant_id: locked.tenant_id, project_id: locked.project_id }, planId: locked.id, eventType: 'COMPENSATION_TRIGGERED', actor, eventKey: `trigger:${locked.id}:${hash(reason)}`, details: { trigger, reason } });
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    return this.getPlan(plan.id, plan.tenant_id);
  }

  async claimNext({ workerId = `compensator:${randomUUID()}`, tenantId = null } = {}) {
    const token = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const params = [token, this.leaseSeconds];
      let tenantClause = '';
      if (tenantId) { params.push(tenantId); tenantClause = `AND p.tenant_id=$${params.length}`; }
      const result = await client.query(`WITH candidate AS (
        SELECT s.id FROM forge_compensation_steps s JOIN forge_compensation_plans p ON p.id=s.plan_id
        WHERE p.status='COMPENSATING' AND s.status IN ('PENDING','FAILED') AND s.available_at<=now()
          AND (s.lease_until IS NULL OR s.lease_until<now()) ${tenantClause}
          AND NOT EXISTS (SELECT 1 FROM forge_compensation_steps h WHERE h.plan_id=s.plan_id AND h.sequence_no>s.sequence_no AND h.status NOT IN ('SUCCEEDED','SKIPPED','QUARANTINED'))
          AND (s.requires_approval=false OR EXISTS (SELECT 1 FROM forge_compensation_approvals a WHERE a.step_id=s.id AND a.status='APPROVED' AND (a.expires_at IS NULL OR a.expires_at>now())))
        ORDER BY s.sequence_no DESC,s.created_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT 1)
        UPDATE forge_compensation_steps s SET status='LEASED',lease_token=$1,lease_until=now()+($2::text||' seconds')::interval,attempts=s.attempts+1 WHERE s.id=(SELECT id FROM candidate) RETURNING s.*`, params);
      const step = result.rows[0] || null;
      if (step) await client.query('UPDATE forge_compensation_plans SET status=\'COMPENSATING\' WHERE id=$1 AND status=\'ACTIVE\'', [step.plan_id]);
      await client.query('COMMIT');
      return step ? { ...step, workerId, fencingToken: token } : null;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async executeClaimed(step, { workerId = 'compensator', fencingToken = step?.lease_token } = {}) {
    if (!step) return null;
    const owned = await this.pool.query(`UPDATE forge_compensation_steps SET status='RUNNING' WHERE id=$1 AND status='LEASED' AND lease_token=$2 AND lease_until>now() RETURNING *`, [step.id, fencingToken]);
    if (!owned.rows[0]) throw Object.assign(new Error('Compensation lease lost'), { code: 'COMPENSATION_FENCE_LOST', retryable: true });
    try {
      const effects = (await this.pool.query('SELECT * FROM forge_compensation_side_effects WHERE step_id=$1 ORDER BY created_at,id', [step.id])).rows;
      if (!effects.length) return this.#finishStep(step, 'SKIPPED', null, workerId, fencingToken);
      const result = await this.#executeAction(step, effects);
      await this.#finishStep(step, result.status || 'SUCCEEDED', null, workerId, fencingToken);
      return result;
    } catch (error) {
      const retryable = error?.retryable !== false && step.attempts < step.max_attempts;
      const delay = Math.min(BACKOFF_MAX_SECONDS, Math.max(1, 2 ** Math.min(step.attempts - 1, 8)));
      if (error?.code === 'COMPENSATION_APPROVAL_REQUIRED') {
        await this.#finishStep(step, 'QUARANTINED', error, workerId, fencingToken);
        return { status: 'QUARANTINED', error: safeError(error) };
      }
      await this.pool.query(`UPDATE forge_compensation_steps SET status=$3,lease_token=NULL,lease_until=NULL,available_at=now()+($4::text||' seconds')::interval,next_backoff_seconds=$4,last_error=$5::jsonb,finished_at=CASE WHEN $3='FAILED' THEN now() ELSE finished_at END
        WHERE id=$1 AND status='RUNNING' AND lease_token=$2`, [step.id, fencingToken, retryable ? 'FAILED' : 'QUARANTINED', delay, JSON.stringify(safeError(error))]);
      await this.#event({ query: this.pool.query.bind(this.pool) }, { workflow: await this.#scope(step.plan_id), planId: step.plan_id, stepId: step.id, eventType: retryable ? 'COMPENSATION_RETRY_SCHEDULED' : 'COMPENSATION_QUARANTINED', actor: workerId, fencingToken, eventKey: `step-error:${step.id}:${step.attempts}:${hash(safeError(error))}`, details: safeError(error) });
      if (!retryable) await this.#reconcilePlan(step.plan_id);
      return { status: retryable ? 'FAILED' : 'QUARANTINED', error: safeError(error) };
    }
  }

  async #executeAction(step, effects) {
    const spec = step.compensation_spec || {};
    if (step.action_type === 'NON_COMPENSATABLE') throw Object.assign(new Error(`Stage ${step.stage} is not safely reversible`), { code: 'COMPENSATION_APPROVAL_REQUIRED', retryable: false });
    if (step.action_type === 'RELEASE_RESERVATION') {
      for (const effect of effects) await this.pool.query(`UPDATE usage_reservations r SET status='RELEASED',terminal_reason='SAGA_COMPENSATED',settled_at=COALESCE(settled_at,now()) WHERE r.job_id=$1 AND r.attempt=$2 AND r.status='HELD' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.id=(SELECT project_id FROM forge_compensation_plans WHERE id=$3))`, [effect.job_id, effect.attempt, step.plan_id]);
      return { status: 'SUCCEEDED', action: step.action_type };
    }
    if (step.action_type === 'CANCEL_PUBLISH') {
      for (const effect of effects) {
        if (!effect.external_reference) continue;
        const run = (await this.pool.query(`SELECT r.*,e.project_id,p.tenant_id FROM publish_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id JOIN forge_compensation_plans c ON c.project_id=e.project_id WHERE r.id=$1 AND c.id=$2`, [effect.external_reference, step.plan_id])).rows[0];
        if (!run) throw Object.assign(new Error('Publish run is outside the compensation scope'), { code: 'TENANT_SCOPE_VIOLATION', retryable: false });
        if (run.status === 'PUBLISHED') throw Object.assign(new Error('Published destination cannot be automatically reversed'), { code: 'COMPENSATION_APPROVAL_REQUIRED', retryable: false });
        await this.pool.query(`UPDATE publish_runs SET status='CANCELLED',error=jsonb_build_object('code','SAGA_COMPENSATED'),finished_at=COALESCE(finished_at,now()) WHERE id=$1 AND status IN ('QUEUED','UPLOADING')`, [run.id]);
      }
      return { status: 'SUCCEEDED', action: step.action_type };
    }
    if (step.action_type === 'QUARANTINE_ARTIFACT') {
      const plan = await this.#scope(step.plan_id);
      for (const effect of effects) for (const artifactId of (effect.artifact_ids || [])) {
        const artifact = (await this.pool.query(`SELECT a.id,a.version_id,a.episode_id,e.project_id,p.tenant_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1`, [artifactId])).rows[0];
        if (!artifact || artifact.project_id !== plan.project_id || artifact.tenant_id !== plan.tenant_id) throw Object.assign(new Error('Artifact is outside the compensation scope'), { code: 'TENANT_SCOPE_VIOLATION', retryable: false });
        await this.pool.query(`INSERT INTO forge_compensation_artifact_quarantines(id,tenant_id,project_id,plan_id,step_id,artifact_id,version_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(plan_id,artifact_id) DO NOTHING`, [`quarantine:${step.plan_id}:${artifact.id}`, plan.tenant_id, plan.project_id, step.plan_id, step.id, artifact.id, artifact.version_id, 'SAGA_COMPENSATION']);
      }
      return { status: 'SUCCEEDED', action: step.action_type };
    }
    if (step.action_type === 'PROVIDER_HTTP') {
      if (!spec.endpoint) throw Object.assign(new Error(`No compensation endpoint configured for ${step.stage}`), { code: 'COMPENSATION_APPROVAL_REQUIRED', retryable: false });
      const plan = await this.#scope(step.plan_id);
      for (const effect of effects) {
        const response = await this.fetchImpl(spec.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.FORGE_STAGE_PROVIDER_TOKEN ? { authorization: `Bearer ${process.env.FORGE_STAGE_PROVIDER_TOKEN}` } : {}) }, body: JSON.stringify({ contractVersion: 'forge-compensation-v1', action: 'COMPENSATE', stage: step.stage, idempotencyKey: step.idempotency_key, tenantId: plan.tenant_id, projectId: plan.project_id, workflowId: plan.workflow_id, effect: { jobId: effect.job_id, attempt: effect.attempt, externalReference: effect.external_reference, inputVersionIds: effect.input_version_ids, outputVersionIds: effect.output_version_ids, artifactIds: effect.artifact_ids, providerRunId: effect.provider_run_id } }) });
        if (!response.ok) throw Object.assign(new Error(`Compensation provider returned HTTP ${response.status}`), { code: 'COMPENSATION_PROVIDER_ERROR', retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
      }
      return { status: 'SUCCEEDED', action: step.action_type };
    }
    throw Object.assign(new Error(`Unsupported compensation action ${step.action_type}`), { code: 'COMPENSATION_ACTION_INVALID', retryable: false });
  }

  async #finishStep(step, status, error, actor, fencingToken) {
    const updated = await this.pool.query(`UPDATE forge_compensation_steps SET status=$3,lease_token=NULL,lease_until=NULL,last_error=$4::jsonb,finished_at=CASE WHEN $3 IN ('SUCCEEDED','SKIPPED','QUARANTINED') THEN now() ELSE finished_at END WHERE id=$1 AND status='RUNNING' AND lease_token=$2 RETURNING *`, [step.id, fencingToken, status, JSON.stringify(error ? safeError(error) : null)]);
    if (!updated.rows[0]) throw Object.assign(new Error('Compensation fence lost while finalizing'), { code: 'COMPENSATION_FENCE_LOST', retryable: true });
    const scope = await this.#scope(step.plan_id);
    await this.#event({ query: this.pool.query.bind(this.pool) }, { workflow: scope, planId: step.plan_id, stepId: step.id, eventType: `COMPENSATION_${status}`, actor, fencingToken, eventKey: `step:${step.id}:${status}:${step.attempts}`, details: error ? safeError(error) : {} });
    await this.#reconcilePlan(step.plan_id);
    return updated.rows[0];
  }

  async #reconcilePlan(planId) {
    const plan = await this.#scope(planId);
    const steps = (await this.pool.query('SELECT * FROM forge_compensation_steps WHERE plan_id=$1 ORDER BY sequence_no DESC', [planId])).rows;
    if (steps.some((s) => s.status === 'QUARANTINED')) await this.pool.query("UPDATE forge_compensation_plans SET status='QUARANTINED',finished_at=COALESCE(finished_at,now()) WHERE id=$1 AND status<>'CANCELLED'", [planId]);
    else if (steps.length && steps.every((s) => TERMINAL_STEP.has(s.status))) await this.pool.query("UPDATE forge_compensation_plans SET status='COMPENSATED',finished_at=COALESCE(finished_at,now()) WHERE id=$1 AND status<>'CANCELLED'", [planId]);
    else if (steps.some((s) => s.status === 'FAILED')) await this.pool.query("UPDATE forge_compensation_plans SET status='PARTIAL' WHERE id=$1 AND status='COMPENSATING'", [planId]);
    return this.getPlan(planId, plan.tenant_id);
  }

  async recoverExpiredLeases() {
    const result = await this.pool.query(`UPDATE forge_compensation_steps SET status='PENDING',lease_token=NULL,lease_until=NULL,available_at=now(),last_error=jsonb_build_object('code','COMPENSATION_LEASE_EXPIRED') WHERE status IN ('LEASED','RUNNING') AND lease_until<now() RETURNING id,plan_id`);
    return result.rowCount;
  }

  async recoverStaleWorkflows({ staleAfterSeconds = Number.parseInt(process.env.FORGE_COMPENSATION_STALE_SECONDS || '3600', 10), actor = 'stale-recovery' } = {}) {
    const rows = await this.pool.query(`SELECT DISTINCT w.id FROM episode_workflows w JOIN episode_workflow_stages s ON s.workflow_id=w.id WHERE w.status='RUNNING' AND s.status IN ('QUEUED','RUNNING') AND s.updated_at<now()-($1::text||' seconds')::interval`, [staleAfterSeconds]);
    const triggered = [];
    for (const row of rows.rows) triggered.push(await this.triggerForWorkflow({ workflowId: row.id, actor, trigger: 'STALE_EXECUTION', reason: { staleAfterSeconds } }));
    return triggered;
  }

  async approve({ planId, stepId = null, tenantId, projectId, actor, reason = 'operator approval', expiresMinutes = 60 } = {}) {
    const plan = await this.getPlan(planId, tenantId);
    if (!plan || plan.project_id !== projectId) throw Object.assign(new Error('Compensation plan not found in tenant scope'), { code: 'NOT_FOUND' });
    const id = `capproval:${randomUUID()}`;
    await this.pool.query(`INSERT INTO forge_compensation_approvals(id,tenant_id,project_id,plan_id,step_id,requested_by,status,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,'APPROVED',$7,now()+($8::text||' minutes')::interval)`, [id, tenantId, projectId, planId, stepId, actor, reason, Math.max(1, Math.min(1440, Number(expiresMinutes) || 60))]);
    return (await this.pool.query('SELECT * FROM forge_compensation_approvals WHERE id=$1', [id])).rows[0];
  }

  async getPlan(planId, tenantId = null) {
    const params = [planId]; let tenantClause = '';
    if (tenantId) { params.push(tenantId); tenantClause = `AND p.tenant_id=$2`; }
    const plan = (await this.pool.query(`SELECT p.* FROM forge_compensation_plans p WHERE p.id=$1 ${tenantClause}`, params)).rows[0];
    if (!plan) return null;
    const steps = (await this.pool.query('SELECT * FROM forge_compensation_steps WHERE plan_id=$1 ORDER BY sequence_no', [planId])).rows;
    const effects = (await this.pool.query('SELECT * FROM forge_compensation_side_effects WHERE plan_id=$1 ORDER BY created_at,id', [planId])).rows;
    const approvals = (await this.pool.query('SELECT * FROM forge_compensation_approvals WHERE plan_id=$1 ORDER BY created_at DESC', [planId])).rows;
    return { ...plan, steps, sideEffects: effects, approvals };
  }

  async health({ tenantId = null } = {}) {
    const params = []; let where = '';
    if (tenantId) { params.push(tenantId); where = 'WHERE tenant_id=$1'; }
    const counts = await this.pool.query(`SELECT status,count(*)::int AS count FROM forge_compensation_plans ${where} GROUP BY status`, params);
    const steps = await this.pool.query(`SELECT status,count(*)::int AS count FROM forge_compensation_steps s JOIN forge_compensation_plans p ON p.id=s.plan_id ${tenantId ? 'WHERE p.tenant_id=$1' : ''} GROUP BY status`, params);
    return { plans: counts.rows, steps: steps.rows, staleLeases: Number((await this.pool.query(`SELECT count(*)::int AS count FROM forge_compensation_steps s JOIN forge_compensation_plans p ON p.id=s.plan_id WHERE s.lease_until<now() ${tenantId ? 'AND p.tenant_id=$1' : ''}`, params)).rows[0]?.count || 0) };
  }

  async #scope(planId) {
    const row = (await this.pool.query('SELECT id,tenant_id,project_id,workflow_id FROM forge_compensation_plans WHERE id=$1', [planId])).rows[0];
    if (!row) throw Object.assign(new Error('Compensation plan not found'), { code: 'NOT_FOUND' });
    return row;
  }
  async #event(client, { workflow, planId, stepId = null, eventType, actor, fencingToken = null, eventKey, details = {} }) {
    await client.query(`INSERT INTO forge_compensation_events(tenant_id,project_id,plan_id,step_id,event_type,actor,fencing_token,event_key,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(event_key) DO NOTHING`, [workflow.tenant_id, workflow.project_id, planId, stepId, eventType, actor, fencingToken, eventKey, JSON.stringify(details)]);
  }
}

module.exports = { CompensationSagaService, STAGE_ORDER, actionForStage, hash };
