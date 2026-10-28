const { createHash } = require('node:crypto');
const { JobQueue } = require('../persistence/job-queue');

const STAGES = Object.freeze([
  'RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'TRANSCRIPTION', 'ASSETS',
  'TIMELINE', 'CAPTIONS', 'RENDER', 'QA', 'PACKAGING', 'PUBLISH',
]);
const DEPENDENCIES = Object.freeze({
  RESEARCH: [], SCRIPT: ['RESEARCH'], SCENE_PLAN: ['SCRIPT'],
  NARRATION: ['SCRIPT', 'SCENE_PLAN'], TRANSCRIPTION: ['NARRATION'], ASSETS: ['SCENE_PLAN'],
  TIMELINE: ['SCENE_PLAN', 'NARRATION', 'TRANSCRIPTION', 'ASSETS'], CAPTIONS: ['TIMELINE'],
  RENDER: ['TIMELINE', 'CAPTIONS'], QA: ['RENDER'], PACKAGING: ['QA'], PUBLISH: ['PACKAGING'],
});
const STAGE_KIND = Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, `workflow:${stage.toLowerCase()}`])));
STAGE_KIND.TIMELINE = 'workflow:timeline-manifest';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function validateStages(stages) {
  const requested = stages?.length ? [...stages] : [...STAGES];
  for (const stage of requested) {
    if (!STAGES.includes(stage)) throw Object.assign(new Error(`Unknown workflow stage: ${stage}`), { code: 'INVALID_STAGE' });
    for (const dependency of DEPENDENCIES[stage]) if (!requested.includes(dependency)) {
      throw Object.assign(new Error(`Stage ${stage} requires ${dependency}`), { code: 'DEPENDENCY_BLOCKED' });
    }
  }
  return requested;
}

function workflowIdempotencyKey(episodeId, stages, brief) {
  const digest = createHash('sha256').update(JSON.stringify({ episodeId, stages, brief })).digest('hex');
  return `episode-workflow:${episodeId}:${digest}`;
}

class EpisodeWorkflowIntegration {
  constructor({ pool, queue = null, leaseSeconds = 300, maxAttempts = 3 } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.queue = queue || new JobQueue({ pool, leaseSeconds });
    this.maxAttempts = maxAttempts;
  }

  async start({ episodeId, projectId = null, brief, actor = 'workflow', stages = STAGES, idempotencyKey = null }) {
    if (!episodeId || !String(brief || '').trim()) throw new TypeError('episodeId and brief are required');
    const requestedStages = validateStages(stages);
    const key = idempotencyKey || workflowIdempotencyKey(episodeId, requestedStages, brief);
    const workflowId = `ewf:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM episode_workflows WHERE idempotency_key=$1 FOR UPDATE', [key]);
      if (existing.rows[0]) { await client.query('COMMIT'); return this.getWorkflow(existing.rows[0].id); }
      const episode = await client.query('SELECT * FROM episodes WHERE id=$1 FOR UPDATE', [episodeId]);
      if (!episode.rows[0]) throw Object.assign(new Error('Episode not found'), { code: 'NOT_FOUND' });
      const effectiveProjectId = projectId || episode.rows[0].project_id;
      await client.query(`INSERT INTO episode_workflows(id,episode_id,project_id,brief,requested_stages,status,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5::jsonb,'QUEUED',$6,$7)`, [workflowId, episodeId, effectiveProjectId, brief, JSON.stringify(requestedStages), key, actor]);
      for (const stage of requestedStages) await client.query('INSERT INTO episode_workflow_stages(workflow_id,stage,status) VALUES($1,$2,\'BLOCKED\')', [workflowId, stage]);
      await client.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details)
        VALUES($1,$2,$3,'WORKFLOW_STARTED','episode_workflow',$4,$5::jsonb)`, [effectiveProjectId, episodeId, actor, workflowId, JSON.stringify({ stages: requestedStages })]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    await this.dispatchReady(workflowId, actor);
    return this.getWorkflow(workflowId);
  }

  async getWorkflow(workflowId) {
    const workflow = await this.pool.query('SELECT * FROM episode_workflows WHERE id=$1', [workflowId]);
    if (!workflow.rows[0]) return null;
    const stages = await this.pool.query('SELECT * FROM episode_workflow_stages WHERE workflow_id=$1 ORDER BY array_position($2::text[], stage)', [workflowId, workflow.rows[0].requested_stages]);
    return { ...this.#hydrate(workflow.rows[0]), stages: stages.rows };
  }

  async dispatchReady(workflowId, actor = 'workflow') {
    const workflowResult = await this.pool.query('SELECT * FROM episode_workflows WHERE id=$1', [workflowId]);
    const workflow = workflowResult.rows[0];
    if (!workflow || TERMINAL.has(workflow.status)) return [];
    const requested = workflow.requested_stages;
    const stagesResult = await this.pool.query('SELECT * FROM episode_workflow_stages WHERE workflow_id=$1', [workflowId]);
    const byStage = new Map(stagesResult.rows.map((row) => [row.stage, row]));
    const dispatched = [];
    for (const stage of requested) {
      const row = byStage.get(stage);
      if (!row || row.status !== 'BLOCKED') continue;
      const deps = DEPENDENCIES[stage];
      if (deps.some((dep) => byStage.get(dep)?.status !== 'SUCCEEDED')) continue;
      const inputVersionIds = deps.flatMap((dep) => byStage.get(dep)?.output_version_ids || []);
      await this.#assertGate(workflow.episode_id, stage, inputVersionIds);
      const dependencyJobIds = deps.map((dep) => byStage.get(dep)?.job_id).filter(Boolean);
      const job = await this.queue.enqueue({
        projectId: workflow.project_id,
        episodeId: workflow.episode_id,
        kind: STAGE_KIND[stage],
        payload: { workflowId, episodeId: workflow.episode_id, projectId: workflow.project_id, brief: workflow.brief, stage, inputVersionIds, actor },
        maxAttempts: this.maxAttempts,
        idempotencyKey: `episode-workflow-job:${workflowId}:${stage}`,
        createdBy: actor,
        dependsOnJobId: dependencyJobIds.length === 1 ? dependencyJobIds[0] : null,
      });
      await this.pool.query(`UPDATE episode_workflow_stages SET status='QUEUED',job_id=$1,input_version_ids=$2::jsonb,updated_at=now()
        WHERE workflow_id=$3 AND stage=$4 AND status='BLOCKED'`, [job.id, JSON.stringify(inputVersionIds), workflowId, stage]);
      await this.#transitionForDispatch(workflow.episode_id, stage, actor);
      dispatched.push(job);
    }
    await this.#reconcileWorkflow(workflowId, actor);
    return dispatched;
  }

  async handleJobSuccess(job, result = {}) {
    const { workflowId, stage, episodeId, projectId } = job.payload || {};
    if (!workflowId || !stage || !STAGES.includes(stage)) return { ignored: true };
    const outputVersionIds = this.#extractVersionIds(result);
    const outputArtifactIds = this.#extractArtifactIds(result);
    try { await this.#verifyOutputs(job, outputVersionIds, outputArtifactIds); }
    catch (error) { return this.handleJobFailure(job, error, true); }
    const updated = await this.pool.query(`UPDATE episode_workflow_stages
      SET status='SUCCEEDED',output_version_ids=$1::jsonb,output_artifact_ids=$2::jsonb,finished_at=COALESCE(finished_at,now()),updated_at=now()
      WHERE workflow_id=$3 AND stage=$4 AND job_id=$5 AND status IN ('QUEUED','RUNNING') RETURNING *`, [JSON.stringify(outputVersionIds), JSON.stringify(outputArtifactIds), workflowId, stage, job.id]);
    if (!updated.rows[0]) return { duplicate: true };
    await this.#advanceEpisode(episodeId, stage, 'SUCCEEDED');
    await this.#audit(episodeId, projectId, job.payload.actor || 'workflow', 'WORKFLOW_STAGE_SUCCEEDED', job.id, { workflowId, stage, outputVersionIds, outputArtifactIds });
    await this.dispatchReady(workflowId, job.payload.actor || 'workflow');
    return { accepted: true };
  }

  async handleJobFailure(job, error, terminal = true) {
    const { workflowId, stage, episodeId, projectId } = job.payload || {};
    if (!workflowId || !stage) return { ignored: true };
    if (!terminal) return { retrying: true };
    const updated = await this.pool.query(`UPDATE episode_workflow_stages SET status='FAILED',error=$1::jsonb,finished_at=now(),updated_at=now()
      WHERE workflow_id=$2 AND stage=$3 AND job_id=$4 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED') RETURNING *`, [JSON.stringify(this.#error(error)), workflowId, stage, job.id]);
    if (!updated.rows[0]) return { duplicate: true };
    await this.pool.query(`UPDATE episode_workflows SET status='FAILED',failure_stage=$1,failure=$2::jsonb,updated_at=now()
      WHERE id=$3 AND status NOT IN ('SUCCEEDED','CANCELLED')`, [stage, JSON.stringify(this.#error(error)), workflowId]);
    await this.#advanceEpisode(episodeId, stage, 'FAILED', error?.message || String(error));
    await this.#audit(episodeId, projectId, 'workflow', 'WORKFLOW_STAGE_FAILED', job.id, { workflowId, stage, error: this.#error(error) });
    return { accepted: true };
  }

  async cancel(workflowId, actor = 'workflow') {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) throw Object.assign(new Error('Workflow not found'), { code: 'NOT_FOUND' });
    if (TERMINAL.has(workflow.status)) return workflow;
    await this.pool.query(`UPDATE episode_workflow_stages SET status='CANCELLED',finished_at=COALESCE(finished_at,now()),updated_at=now()
      WHERE workflow_id=$1 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')`, [workflowId]);
    await this.pool.query('UPDATE forge_jobs SET status=\'CANCELLED\',finished_at=now(),updated_at=now() WHERE id IN (SELECT job_id FROM episode_workflow_stages WHERE workflow_id=$1 AND status=\'CANCELLED\') AND status IN (\'QUEUED\',\'RUNNING\')', [workflowId]);
    await this.pool.query('UPDATE episode_workflows SET status=\'CANCELLED\',updated_at=now() WHERE id=$1', [workflowId]);
    await this.#audit(workflow.episodeId, workflow.projectId, actor, 'WORKFLOW_CANCELLED', workflowId, {});
    return this.getWorkflow(workflowId);
  }

  async recover({ workflowId = null, staleAfterSeconds = 600, actor = 'reconciler' } = {}) {
    await this.queue.recoverExpiredLeases();
    await this.queue.recoverBlockedDependencies();
    const params = [staleAfterSeconds];
    let filter = '';
    if (workflowId) { params.push(workflowId); filter = 'AND w.id=$2'; }
    const rows = await this.pool.query(`SELECT DISTINCT w.id FROM episode_workflows w JOIN episode_workflow_stages s ON s.workflow_id=w.id
      WHERE w.status IN ('QUEUED','RUNNING') AND s.status IN ('QUEUED','RUNNING')
      AND s.updated_at < now()-($1::text||' seconds')::interval ${filter}`, params);
    const recovered = [];
    for (const row of rows.rows) { await this.dispatchReady(row.id, actor); await this.#reconcileWorkflow(row.id, actor); recovered.push(await this.getWorkflow(row.id)); }
    return recovered;
  }

  async #reconcileWorkflow(workflowId, actor) {
    const workflowResult = await this.pool.query('SELECT * FROM episode_workflows WHERE id=$1', [workflowId]);
    const workflow = workflowResult.rows[0]; if (!workflow) return;
    const stages = await this.pool.query('SELECT * FROM episode_workflow_stages WHERE workflow_id=$1', [workflowId]);
    const rows = stages.rows;
    if (rows.some((r) => r.status === 'FAILED')) return;
    if (rows.length && rows.every((r) => r.status === 'SUCCEEDED')) {
      await this.pool.query(`UPDATE episode_workflows SET status='SUCCEEDED',last_safe_stage=$1,current_stage=NULL,updated_at=now() WHERE id=$2 AND status NOT IN ('CANCELLED','FAILED')`, [rows[rows.length - 1].stage, workflowId]);
      await this.#advanceEpisode(workflow.episode_id, 'PUBLISH', 'SUCCEEDED');
      await this.#audit(workflow.episode_id, workflow.project_id, actor, 'WORKFLOW_SUCCEEDED', workflowId, {});
      return;
    }
    const current = rows.find((r) => ['QUEUED', 'RUNNING'].includes(r.status));
    if (current) await this.pool.query(`UPDATE episode_workflows SET status='RUNNING',current_stage=$1,last_safe_stage=$2,updated_at=now() WHERE id=$3`, [current.stage, rows.find((r) => r.status === 'SUCCEEDED')?.stage || null, workflowId]);
  }

  async #assertGate(episodeId, stage, inputVersionIds) {
    if (['SCENE_PLAN', 'NARRATION', 'ASSETS', 'TIMELINE', 'CAPTIONS', 'RENDER'].includes(stage)) await this.#requireApproval(episodeId, 'SCRIPT', inputVersionIds);
    if (['NARRATION', 'ASSETS', 'TIMELINE', 'CAPTIONS', 'RENDER'].includes(stage)) await this.#requireApproval(episodeId, 'SCENE_PLAN', inputVersionIds);
    if (stage === 'PACKAGING') {
      const qa = await this.pool.query(`SELECT 1 FROM qa_results q JOIN artifacts a ON a.id=q.artifact_id AND a.version_id=q.version_id WHERE a.episode_id=$1 AND a.kind='render' AND q.status IN ('PASSED','WARNINGS') ORDER BY q.created_at DESC LIMIT 1`, [episodeId]);
      if (!qa.rows[0]) throw Object.assign(new Error('Packaging is blocked until render QA passes'), { code: 'QA_BLOCKED' });
    }
    if (stage === 'PUBLISH') {
      const result = await this.pool.query('SELECT state,approved_render_id FROM episodes WHERE id=$1', [episodeId]);
      if (result.rows[0]?.state !== 'APPROVED' || !result.rows[0]?.approved_render_id) throw Object.assign(new Error('Publish is blocked until final render approval'), { code: 'APPROVAL_BLOCKED' });
    }
  }

  async #requireApproval(episodeId, approvalStage, inputVersionIds) {
    if (!inputVersionIds.length) throw Object.assign(new Error(`${approvalStage} approval input is missing`), { code: 'INVALID_PROVENANCE' });
    const result = await this.pool.query(`SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND decision='APPROVED' AND target_version_id = ANY($3::text[]) ORDER BY created_at DESC LIMIT 1`, [episodeId, approvalStage, inputVersionIds]);
    if (!result.rows[0]) throw Object.assign(new Error(`${approvalStage} approval required`), { code: 'APPROVAL_BLOCKED' });
  }

  async #verifyOutputs(job, versionIds, artifactIds) {
    if (!versionIds.length && !artifactIds.length) throw Object.assign(new Error(`Stage ${job.payload.stage} returned no immutable outputs`), { code: 'OUTPUT_MISSING', retryable: false });
    if (versionIds.length) { const versions = await this.pool.query('SELECT id FROM version_records WHERE episode_id=$1 AND id=ANY($2::text[])', [job.payload.episodeId, versionIds]); if (versions.rowCount !== versionIds.length) throw Object.assign(new Error('Stage output provenance mismatch'), { code: 'INVALID_PROVENANCE', retryable: false }); }
    if (artifactIds.length) { const artifacts = await this.pool.query('SELECT id FROM artifacts WHERE episode_id=$1 AND id=ANY($2::text[])', [job.payload.episodeId, artifactIds]); if (artifacts.rowCount !== artifactIds.length) throw Object.assign(new Error('Stage artifact provenance mismatch'), { code: 'INVALID_PROVENANCE', retryable: false }); }
  }

  async #transitionForDispatch(episodeId, stage, actor) {
    const target = { RESEARCH: 'RESEARCHING', SCRIPT: 'SCRIPT_DRAFT', SCENE_PLAN: 'PLANNING', RENDER: 'RENDERING', QA: 'QA', PUBLISH: 'PUBLISHING' }[stage];
    if (!target) return;
    const allowed = { RESEARCHING: ['DRAFT','FAILED'], SCRIPT_DRAFT: ['RESEARCHING','FAILED'], PLANNING: ['SCRIPT_APPROVED','PLAN_REVIEW'], RENDERING: ['READY_TO_RENDER','GENERATION'], QA: ['RENDERING'], PUBLISHING: ['APPROVED'] }[target] || [];
    const result = await this.pool.query('SELECT state FROM episodes WHERE id=$1', [episodeId]);
    const state = result.rows[0]?.state;
    if (!allowed.includes(state)) return;
    const updated = await this.pool.query('UPDATE episodes SET state=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND state=$3 RETURNING id', [target, episodeId, state]);
    if (updated.rows[0]) await this.#audit(episodeId, null, actor, 'EPISODE_STATE_TRANSITION', 'episode', episodeId, { from: state, to: target });
  }

  async #advanceEpisode(episodeId, stage, outcome, reason = null) {
    const result = await this.pool.query('SELECT state FROM episodes WHERE id=$1', [episodeId]);
    const state = result.rows[0]?.state; if (!state) return;
    const next = outcome === 'FAILED' ? 'FAILED' : ({ RESEARCH: 'SCRIPT_DRAFT', SCRIPT: 'SCRIPT_REVIEW', SCENE_PLAN: 'PLAN_REVIEW', RENDER: 'QA', QA: 'AWAITING_APPROVAL', PUBLISH: 'PUBLISHED' }[stage] || null);
    if (!next || state === next) return;
    const updated = await this.pool.query('UPDATE episodes SET state=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND state=$3 RETURNING id', [next, episodeId, state]);
    if (updated.rows[0]) await this.#audit(episodeId, null, 'workflow', 'EPISODE_STATE_TRANSITION', 'episode', episodeId, { from: state, to: next, reason });
  }

  async #audit(episodeId, projectId, actor, action, targetType, targetId, details) {
    let pid = projectId; if (!pid) { const result = await this.pool.query('SELECT project_id FROM episodes WHERE id=$1', [episodeId]); pid = result.rows[0]?.project_id; }
    if (!pid) return;
    await this.pool.query('INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [pid, episodeId, actor, action, targetType, targetId, JSON.stringify(details)]);
  }
  #extractVersionIds(result) { return [...new Set((result?.artifacts || []).map((a) => a.versionId).filter(Boolean).concat(result?.versionId ? [result.versionId] : []))]; }
  #extractArtifactIds(result) { return [...new Set((result?.artifacts || []).map((a) => a.id).filter(Boolean).concat(result?.artifactId ? [result.artifactId] : []))]; }
  #error(error) { return { code: error?.code || 'WORKFLOW_STAGE_FAILED', message: error?.message || String(error), retryable: error?.retryable !== false }; }
  #hydrate(row) { return { id: row.id, episodeId: row.episode_id, projectId: row.project_id, brief: row.brief, requestedStages: row.requested_stages, status: row.status, currentStage: row.current_stage, lastSafeStage: row.last_safe_stage, failureStage: row.failure_stage, failure: row.failure, idempotencyKey: row.idempotency_key, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }; }
}

module.exports = { EpisodeWorkflowIntegration, WORKFLOW_STAGES: STAGES, WORKFLOW_DEPENDENCIES: DEPENDENCIES, WORKFLOW_STAGE_KINDS: STAGE_KIND, validateStages, workflowIdempotencyKey };
