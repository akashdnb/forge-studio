const crypto = require('node:crypto');

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
const STATES = new Set(['ACTIVE','SUSPENDED','ARCHIVED','DELETION_REQUESTED','DELETION_IN_PROGRESS','DELETED','LEGAL_HOLD','SAFETY_HOLD']);
const TRANSITIONS = {
  ACTIVE: ['SUSPENDED','ARCHIVED','DELETION_REQUESTED','LEGAL_HOLD','SAFETY_HOLD'],
  SUSPENDED: ['ACTIVE','ARCHIVED','DELETION_REQUESTED','LEGAL_HOLD','SAFETY_HOLD'],
  ARCHIVED: ['ACTIVE','DELETION_REQUESTED','LEGAL_HOLD','SAFETY_HOLD'],
  DELETION_REQUESTED: ['ACTIVE','DELETION_IN_PROGRESS','LEGAL_HOLD','SAFETY_HOLD'],
  DELETION_IN_PROGRESS: ['DELETION_REQUESTED','DELETED','LEGAL_HOLD','SAFETY_HOLD'],
  LEGAL_HOLD: ['ACTIVE','SUSPENDED','ARCHIVED'],
  SAFETY_HOLD: ['ACTIVE','SUSPENDED','ARCHIVED'],
  DELETED: [],
};
const PROTECTED_TABLES = new Set([
  'tenants','deletion_requests','deletion_plans','deletion_plan_items','deletion_audit_evidence',
  'audit_events','security_audit_events','runtime_config_audit','runtime_boot_snapshots',
  'runtime_worker_snapshots','lifecycle_reconciliation','forge_schema_migrations',
]);

class LifecycleError extends Error {
  constructor(code, message, statusCode = 409) { super(message); this.code = code; this.statusCode = statusCode; }
}

class TenantProjectLifecycle {
  constructor({ pool, storage = null, clock = () => new Date(), batchSize = 100 } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pg pool is required');
    this.pool = pool; this.storage = storage; this.clock = clock;
    this.batchSize = Math.max(1, Math.min(1000, batchSize));
  }

  async _scope(client, target) {
    if (!target?.tenantId) throw new LifecycleError('INVALID_SCOPE', 'tenantId is required', 400);
    if (target.projectId) {
      const r = await client.query('SELECT id,tenant_id,lifecycle_state FROM projects WHERE id=$1', [target.projectId]);
      if (!r.rows[0] || r.rows[0].tenant_id !== target.tenantId) throw new LifecycleError('NOT_FOUND', 'project not found', 404);
      return { tenantId: target.tenantId, projectIds: [target.projectId], project: r.rows[0] };
    }
    const t = await client.query('SELECT id,lifecycle_state FROM tenants WHERE id=$1', [target.tenantId]);
    if (!t.rows[0]) throw new LifecycleError('NOT_FOUND', 'tenant not found', 404);
    const p = await client.query('SELECT id,lifecycle_state FROM projects WHERE tenant_id=$1', [target.tenantId]);
    return { tenantId: target.tenantId, projectIds: p.rows.map((x) => x.id), tenant: t.rows[0], projects: p.rows };
  }

  async transition({ tenantId, projectId = null, nextState, actor, reason = '', expectedRevision }) {
    if (!STATES.has(nextState) || !actor || !reason.trim()) throw new LifecycleError('VALIDATION_ERROR', 'state, actor and reason are required', 400);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const scope = await this._scope(c, { tenantId, projectId });
      const table = projectId ? 'projects' : 'tenants';
      const id = projectId || tenantId;
      const current = (await c.query(`SELECT lifecycle_state,revision FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (expectedRevision != null && Number(current.revision) !== Number(expectedRevision)) throw new LifecycleError('REVISION_CONFLICT', 'lifecycle revision changed');
      if (!TRANSITIONS[current.lifecycle_state]?.includes(nextState)) throw new LifecycleError('STATE_CONFLICT', `illegal lifecycle transition ${current.lifecycle_state} -> ${nextState}`);
      if (['DELETION_REQUESTED','DELETION_IN_PROGRESS','DELETED'].includes(nextState)) {
        const holds = await c.query('SELECT 1 FROM lifecycle_holds WHERE tenant_id=$1 AND active AND (project_id IS NULL OR project_id=$2) LIMIT 1', [tenantId, projectId]);
        if (holds.rows[0]) throw new LifecycleError('HOLD_BLOCKED', 'active hold blocks deletion');
        const jobs = await c.query("SELECT count(*)::int n FROM forge_jobs WHERE project_id=ANY($1) AND status IN ('QUEUED','RUNNING')", [scope.projectIds]);
        if (jobs.rows[0].n && nextState === 'DELETION_IN_PROGRESS') throw new LifecycleError('ACTIVE_WORK', 'active jobs must be drained or cancelled');
      }
      const updated = await c.query(`UPDATE ${table} SET lifecycle_state=$1,revision=revision+1,updated_at=now(),suspended_at=CASE WHEN $1='SUSPENDED' THEN now() ELSE suspended_at END,archived_at=CASE WHEN $1='ARCHIVED' THEN now() ELSE archived_at END,deleted_at=CASE WHEN $1='DELETED' THEN now() ELSE deleted_at END WHERE id=$2 RETURNING *`, [nextState, id]);
      await c.query('INSERT INTO audit_events(project_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [projectId, actor, 'lifecycle.transition', projectId ? 'project' : 'tenant', id, JSON.stringify({ from: current.lifecycle_state, to: nextState, reason })]);
      await c.query('COMMIT'); return updated.rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async requestDeletion({ tenantId, projectId = null, actor, reason, idempotencyKey, confirmation }) {
    if (!actor || !reason?.trim() || !idempotencyKey || !confirmation) throw new LifecycleError('VALIDATION_ERROR', 'actor, reason, idempotencyKey and confirmation are required', 400);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const scope = await this._scope(c, { tenantId, projectId });
      const table = projectId ? 'projects' : 'tenants'; const id = projectId || tenantId;
      const current = (await c.query(`SELECT lifecycle_state FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (['DELETED','DELETION_IN_PROGRESS'].includes(current.lifecycle_state)) throw new LifecycleError('STATE_CONFLICT', 'deletion is already in progress');
      const holds = await c.query('SELECT 1 FROM lifecycle_holds WHERE tenant_id=$1 AND active AND (project_id IS NULL OR project_id=$2) LIMIT 1', [tenantId, projectId]);
      if (holds.rows[0]) throw new LifecycleError('HOLD_BLOCKED', 'active hold blocks deletion');
      const existing = await c.query('SELECT * FROM deletion_requests WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) { await c.query('COMMIT'); return { request: existing.rows[0], replayed: true }; }
      const requestId = crypto.randomUUID(); const confirmationHash = sha(confirmation);
      await c.query('INSERT INTO deletion_requests(id,tenant_id,project_id,actor,reason,confirmation_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)', [requestId, tenantId, projectId, actor, reason.trim(), confirmationHash, idempotencyKey]);
      await c.query(`UPDATE ${table} SET lifecycle_state='DELETION_REQUESTED',revision=revision+1,updated_at=now() WHERE id=$1`, [id]);
      await c.query('INSERT INTO deletion_audit_evidence(request_id,tenant_id,project_id,actor,event,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [requestId, tenantId, projectId, actor, 'DELETION_REQUESTED', reason, JSON.stringify({ confirmationHash })]);
      await c.query('COMMIT');
      return { request: (await this.pool.query('SELECT * FROM deletion_requests WHERE id=$1', [requestId])).rows[0], confirmation };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async confirmDeletion({ requestId, tenantId, actor, confirmation }) {
    if (!requestId || !tenantId || !actor || !confirmation) throw new LifecycleError('VALIDATION_ERROR', 'requestId, tenantId, actor and confirmation are required', 400);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const request = (await c.query('SELECT * FROM deletion_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [requestId, tenantId])).rows[0];
      if (!request) throw new LifecycleError('NOT_FOUND', 'deletion request not found', 404);
      if (request.actor !== actor) throw new LifecycleError('FORBIDDEN', 'only the requesting actor may confirm', 403);
      if (request.state !== 'REQUESTED') { await c.query('COMMIT'); return request; }
      if (sha(confirmation) !== request.confirmation_hash) throw new LifecycleError('CONFIRMATION_REQUIRED', 'confirmation does not match', 403);
      await c.query("UPDATE deletion_requests SET state='CONFIRMED',confirmed_at=now(),updated_at=now() WHERE id=$1", [requestId]);
      await c.query('INSERT INTO deletion_audit_evidence(request_id,tenant_id,project_id,actor,event,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [requestId, tenantId, request.project_id, actor, 'DELETION_CONFIRMED', 'explicit confirmation', JSON.stringify({ requestId })]);
      await c.query('COMMIT'); return (await this.pool.query('SELECT * FROM deletion_requests WHERE id=$1', [requestId])).rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async _metadata(c) {
    const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.table_name);
    const cols = (await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows.reduce((m, r) => { (m[r.table_name] ||= []).push(r.column_name); return m; }, {});
    const fks = (await c.query("SELECT tc.table_name child_table,kcu.column_name child_column,ccu.table_name parent_table,ccu.column_name parent_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'")).rows;
    return { tables, cols, fks };
  }

  _scopeExpression(table, alias, meta, seen = new Set()) {
    if (PROTECTED_TABLES.has(table) || seen.has(table)) return null;
    const nextSeen = new Set(seen); nextSeen.add(table); const cols = meta.cols[table] || []; const parts = [];
    if (cols.includes('tenant_id')) parts.push(`${alias}.tenant_id = $1`);
    if (cols.includes('project_id')) parts.push(`${alias}.project_id = ANY($2)`);
    if (cols.includes('episode_id')) parts.push(`${alias}.episode_id IN (SELECT id FROM episodes WHERE project_id=ANY($2))`);
    if (cols.includes('artifact_id')) parts.push(`${alias}.artifact_id IN (SELECT a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id WHERE e.project_id=ANY($2))`);
    if (cols.includes('version_id')) parts.push(`${alias}.version_id IN (SELECT v.id FROM version_records v JOIN episodes e ON e.id=v.episode_id WHERE e.project_id=ANY($2))`);
    if (cols.includes('provider_run_id')) parts.push(`${alias}.provider_run_id IN (SELECT r.id FROM provider_runs r JOIN episodes e ON e.id=r.episode_id WHERE e.project_id=ANY($2))`);
    if (cols.includes('job_id')) parts.push(`${alias}.job_id IN (SELECT j.id FROM forge_jobs j WHERE j.project_id=ANY($2))`);
    if (table === 'projects') parts.push(`${alias}.id=ANY($2)`);
    if (table === 'tenants') parts.push(`${alias}.id=$1`);
    for (const fk of meta.fks.filter((x) => x.child_table === table)) {
      const parent = this._scopeExpression(fk.parent_table, 'p', meta, nextSeen);
      if (parent) parts.push(`EXISTS (SELECT 1 FROM ${fk.parent_table} p WHERE p.${fk.parent_column}=${alias}.${fk.child_column} AND (${parent}))`);
    }
    return parts.length ? parts.join(' OR ') : null;
  }

  async _countIf(c, table, column, ids) {
    const exists = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [table]);
    if (!exists.rows[0]) return 0;
    const col = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2", [table, column]);
    if (!col.rows[0]) return 0;
    return (await c.query(`SELECT count(*)::int n FROM ${table} WHERE ${column} = ANY($1)`, [ids])).rows[0].n;
  }

  async plan({ requestId, tenantId, actor, dryRun = true }) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const request = (await c.query('SELECT * FROM deletion_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [requestId, tenantId])).rows[0];
      if (!request) throw new LifecycleError('NOT_FOUND', 'deletion request not found', 404);
      if (request.actor !== actor) throw new LifecycleError('FORBIDDEN', 'request actor mismatch', 403);
      if (!['CONFIRMED','PLANNED','BLOCKED'].includes(request.state)) throw new LifecycleError('STATE_CONFLICT', 'request must be explicitly confirmed');
      const holds = await c.query('SELECT id,kind,reason FROM lifecycle_holds WHERE tenant_id=$1 AND active AND (project_id IS NULL OR project_id=$2)', [tenantId, request.project_id]);
      if (holds.rows.length) throw new LifecycleError('HOLD_BLOCKED', 'active hold blocks deletion');
      const scope = await this._scope(c, { tenantId, projectId: request.project_id });
      const activeJobs = (await c.query("SELECT count(*)::int n FROM forge_jobs WHERE project_id=ANY($1) AND status IN ('QUEUED','RUNNING')", [scope.projectIds])).rows[0].n;
      const publish = (await c.query("SELECT count(*)::int n FROM publish_runs pr JOIN episodes e ON e.id=pr.episode_id WHERE e.project_id=ANY($1) AND pr.status IN ('QUEUED','UPLOADING')", [scope.projectIds])).rows[0].n;
      const reservations = await this._countIf(c, 'usage_reservations', 'project_id', scope.projectIds);
      const executions = await this._countIf(c, 'github_actions_executions', 'project_id', scope.projectIds);
      const exportsCount = await this._countIf(c, 'export_jobs', 'project_id', scope.projectIds);
      const backups = await this._countIf(c, 'backup_records', 'tenant_id', [tenantId]);
      const meta = await this._metadata(c); const resources = [];
      for (const table of meta.tables) {
        if (PROTECTED_TABLES.has(table)) continue;
        const expression = this._scopeExpression(table, 't', meta);
        if (!expression) continue;
        const count = (await c.query(`SELECT count(*)::int n FROM ${table} t WHERE ${expression}`, [tenantId, scope.projectIds])).rows[0].n;
        if (count) resources.push({ resourceType: table, resourceId: '*', count, action: ['artifacts','storage_objects'].includes(table) ? 'QUARANTINE' : 'DELETE' });
      }
      const blockers = [];
      if (activeJobs) blockers.push({ type: 'ACTIVE_JOBS', count: activeJobs });
      if (publish) blockers.push({ type: 'IN_FLIGHT_PUBLISH', count: publish });
      if (reservations) blockers.push({ type: 'BUDGET_RESERVATIONS', count: reservations });
      if (executions) blockers.push({ type: 'RUNNER_EXECUTIONS', count: executions });
      if (exportsCount) blockers.push({ type: 'EXPORTS', count: exportsCount });
      if (backups) blockers.push({ type: 'BACKUPS', count: backups });
      const fingerprint = sha(JSON.stringify({ tenantId, projectId: request.project_id, resources, blockers })); const planId = crypto.randomUUID();
      const status = blockers.length ? 'BLOCKED' : 'READY';
      await c.query('INSERT INTO deletion_plans(id,request_id,revision,status,target_count,eligible_count,blocked_count,impact,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)', [planId, requestId, Number(request.plan_revision) + 1, status, resources.reduce((n, x) => n + x.count, 0), resources.filter((x) => x.action !== 'BLOCK').reduce((n, x) => n + x.count, 0), blockers.length, JSON.stringify({ resources, blockers }), fingerprint]);
      let ordinal = 0;
      for (const resource of resources) await c.query('INSERT INTO deletion_plan_items(plan_id,ordinal,resource_type,resource_id,action,reason) VALUES($1,$2,$3,$4,$5,$6)', [planId, ordinal++, resource.resourceType, resource.resourceId, resource.action, blockers.length ? 'dependency must be drained before deletion' : 'eligible by tenant/project reachability']);
      await c.query('UPDATE deletion_requests SET state=$1,plan_revision=plan_revision+1,updated_at=now() WHERE id=$2', [status === 'READY' ? 'PLANNED' : 'BLOCKED', requestId]);
      await c.query('INSERT INTO deletion_audit_evidence(request_id,tenant_id,project_id,actor,event,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [requestId, tenantId, request.project_id, actor, dryRun ? 'DELETION_DRY_RUN' : 'DELETION_PLANNED', 'planner result', JSON.stringify({ planId, fingerprint, blockers })]);
      await c.query('COMMIT'); return { planId, status, resources, blockers, fingerprint };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async execute({ requestId, tenantId, actor, limit = this.batchSize }) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const request = (await c.query('SELECT * FROM deletion_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [requestId, tenantId])).rows[0];
      if (!request) throw new LifecycleError('NOT_FOUND', 'deletion request not found', 404);
      if (request.actor !== actor) throw new LifecycleError('FORBIDDEN', 'request actor mismatch', 403);
      if (request.state !== 'PLANNED') throw new LifecycleError('STATE_CONFLICT', 'request is not ready for execution');
      const plan = (await c.query('SELECT * FROM deletion_plans WHERE request_id=$1 ORDER BY revision DESC LIMIT 1', [requestId])).rows[0];
      if (!plan || plan.status !== 'READY') throw new LifecycleError('STATE_CONFLICT', 'no ready deletion plan');
      const scope = await this._scope(c, { tenantId, projectId: request.project_id });
      await c.query("UPDATE deletion_requests SET state='RUNNING',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1", [requestId]);
      await c.query(`UPDATE ${request.project_id ? 'projects' : 'tenants'} SET lifecycle_state='DELETION_IN_PROGRESS',revision=revision+1,updated_at=now() WHERE id=$1`, [request.project_id || tenantId]);
      const items = (await c.query("SELECT * FROM deletion_plan_items WHERE plan_id=$1 AND status IN ('PENDING','FAILED') ORDER BY ordinal LIMIT $2 FOR UPDATE SKIP LOCKED", [plan.id, Math.max(1, Math.min(100, limit))])).rows;
      let completed = 0; let blocked = 0;
      for (const item of items) {
        await c.query("UPDATE deletion_plan_items SET status='RUNNING',updated_at=now() WHERE id=$1", [item.id]);
        try {
          const meta = await this._metadata(c); const expression = this._scopeExpression(item.resource_type, 't', meta);
          if (!expression) throw new LifecycleError('UNKNOWN_SCOPE', `cannot prove scope for ${item.resource_type}`);
          if (['storage_objects','artifacts'].includes(item.resource_type)) {
            const rows = await c.query(`SELECT * FROM ${item.resource_type} t WHERE ${expression} LIMIT $3`, [tenantId, scope.projectIds, Math.max(1, Math.min(100, limit))]);
            for (const row of rows.rows) {
              if (item.resource_type === 'storage_objects' && row.storage_key) {
                if (!this.storage || typeof this.storage.delete !== 'function') throw new LifecycleError('EXTERNAL_STORAGE_UNKNOWN', 'storage adapter unavailable; refusing deletion');
                await this.storage.delete(row.storage_key);
              }
              if (item.resource_type === 'artifacts' && row.storage_uri) {
                const storageRow = (await c.query('SELECT * FROM storage_objects WHERE artifact_id=$1 FOR UPDATE', [row.id])).rows[0];
                if (storageRow?.storage_key) {
                  if (!this.storage || typeof this.storage.delete !== 'function') throw new LifecycleError('EXTERNAL_STORAGE_UNKNOWN', 'storage adapter unavailable; refusing deletion');
                  await this.storage.delete(storageRow.storage_key); await c.query('DELETE FROM storage_objects WHERE id=$1', [storageRow.id]);
                }
              }
              await c.query(`DELETE FROM ${item.resource_type} WHERE id=$1`, [row.id]); completed++;
            }
          } else {
            const result = await c.query(`DELETE FROM ${item.resource_type} t WHERE ${expression}`, [tenantId, scope.projectIds]); completed += result.rowCount;
          }
          await c.query("UPDATE deletion_plan_items SET status='SUCCEEDED',updated_at=now() WHERE id=$1", [item.id]);
        } catch (error) {
          blocked++;
          await c.query("UPDATE deletion_plan_items SET status='BLOCKED',last_error=$2::jsonb,updated_at=now() WHERE id=$1", [item.id, JSON.stringify({ code: error.code || 'DELETE_BLOCKED', message: error.message })]);
        }
      }
      const remaining = (await c.query("SELECT count(*)::int n FROM deletion_plan_items WHERE plan_id=$1 AND status IN ('PENDING','RUNNING','BLOCKED','FAILED')", [plan.id])).rows[0].n;
      const activeJobs = (await c.query("SELECT count(*)::int n FROM forge_jobs WHERE project_id=ANY($1) AND status IN ('QUEUED','RUNNING')", [scope.projectIds])).rows[0].n;
      if (!remaining && !activeJobs) {
        if (request.project_id) await c.query('UPDATE projects SET lifecycle_state=\'DELETED\',revision=revision+1,deleted_at=now(),updated_at=now() WHERE id=$1', [request.project_id]);
        else { await c.query('DELETE FROM projects WHERE tenant_id=$1', [tenantId]); await c.query("UPDATE tenants SET lifecycle_state='DELETED',revision=revision+1,deleted_at=now(),updated_at=now() WHERE id=$1", [tenantId]); }
        await c.query("UPDATE deletion_requests SET state='COMPLETED',finished_at=now(),updated_at=now() WHERE id=$1", [requestId]);
      } else await c.query("UPDATE deletion_requests SET state='BLOCKED',updated_at=now() WHERE id=$1", [requestId]);
      await c.query('INSERT INTO deletion_audit_evidence(request_id,tenant_id,project_id,actor,event,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [requestId, tenantId, request.project_id, actor, 'DELETION_EXECUTION', 'bounded deletion execution', JSON.stringify({ completed, blocked, remaining, activeJobs })]);
      await c.query('COMMIT'); return { requestId, completed, blocked, remaining, activeJobs, state: !remaining && !activeJobs ? 'COMPLETED' : 'BLOCKED' };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async reconcile({ tenantId, projectId = null }) {
    const c = await this.pool.connect();
    try {
      const scope = await this._scope(c, { tenantId, projectId });
      const activeJobs = (await c.query("SELECT count(*)::int n FROM forge_jobs WHERE project_id=ANY($1) AND status IN ('QUEUED','RUNNING')", [scope.projectIds])).rows[0].n;
      const holds = (await c.query('SELECT count(*)::int n FROM lifecycle_holds WHERE tenant_id=$1 AND active', [tenantId])).rows[0].n;
      const blocked = (await c.query("SELECT count(*)::int n FROM deletion_requests WHERE tenant_id=$1 AND state IN ('RUNNING','BLOCKED')", [tenantId])).rows[0].n;
      const id = crypto.randomUUID(); await c.query('INSERT INTO lifecycle_reconciliation(id,tenant_id,project_id,orphan_count,retention_drift_count,blocked_count,details) VALUES($1,$2,$3,0,0,$4,$5::jsonb)', [id, tenantId, projectId, blocked, JSON.stringify({ activeJobs, activeHolds: holds })]);
      return { id, activeJobs, activeHolds: holds, blockedRequests: blocked };
    } finally { c.release(); }
  }
}

module.exports = { TenantProjectLifecycle, LifecycleError, STATES };
