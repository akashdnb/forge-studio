const crypto = require('node:crypto');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const STATEMENT_TIMEOUT_MS = 2500;
const MAX_QUERY_LENGTH = 256;
const MAX_CONCURRENT_SEARCHES = 32;
const SOURCE_TYPES = new Set(['project','episode','version','artifact','job','provider_run','approval','qa','publish_run','cost','audit_event','usage','budget']);
const STATES = new Set(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','DRAFT','RESEARCHING','SCRIPT_DRAFT','SCRIPT_REVIEW','SCRIPT_APPROVED','PLANNING','PLAN_REVIEW','GENERATION','READY_TO_RENDER','RENDERING','QA','AWAITING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED']);

function validation(message) { return Object.assign(new TypeError(message), { code: 'VALIDATION_ERROR' }); }
function parseCsv(value, allowed, name) {
  if (value == null || value === '') return [];
  const values = String(value).split(',').map(v => v.trim()).filter(Boolean);
  if (values.length > 12 || values.some(v => !allowed.has(v))) throw validation(`Invalid ${name}`);
  return [...new Set(values)];
}
function parseDate(value, name) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw validation(`Invalid ${name}`);
  return d.toISOString();
}
function parseLimit(value) {
  const n = value == null || value === '' ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw validation(`limit must be between 1 and ${MAX_LIMIT}`);
  return n;
}
function encodeCursor(cursor) { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'); }
function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.rank !== 'number' || typeof parsed.updatedAt !== 'string' || typeof parsed.sourceType !== 'string' || typeof parsed.sourceId !== 'string') throw new Error('bad');
    return parsed;
  } catch { throw validation('Invalid cursor'); }
}
function normalizeQuery(value) {
  const query = String(value || '').trim();
  if (query.length > MAX_QUERY_LENGTH) throw validation(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) throw validation('query contains unsupported control characters');
  return query;
}

class SearchConcurrency {
  constructor(max = MAX_CONCURRENT_SEARCHES) { this.max = max; this.active = 0; }
  acquire() { if (this.active >= this.max) return false; this.active += 1; return true; }
  release() { this.active = Math.max(0, this.active - 1); }
}

function projectScopeWhere({ tenantId, actor, projectId, episodeId, sourceTypes, state, stage, provider, artifactKind, from, to }, params) {
  const actorIndex = params.push(actor);
  const tenantIndex = params.push(tenantId);
  const clauses = [
    `d.tenant_id = $${tenantIndex}`,
    `(EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=d.project_id AND pm.tenant_id=d.tenant_id AND pm.actor_id=$${actorIndex}) OR EXISTS (SELECT 1 FROM projects owner_project WHERE owner_project.id=d.project_id AND owner_project.tenant_id=d.tenant_id AND owner_project.created_by=$${actorIndex}))`,
  ];
  if (projectId) clauses.push(`d.project_id = $${params.push(projectId)}`);
  if (episodeId) clauses.push(`d.episode_id = $${params.push(episodeId)}`);
  if (sourceTypes.length) clauses.push(`d.source_type = ANY($${params.push(sourceTypes)}::text[])`);
  if (state) clauses.push(`d.state = $${params.push(state)}`);
  if (stage) clauses.push(`d.stage = $${params.push(stage)}`);
  if (provider) clauses.push(`d.provider = $${params.push(provider)}`);
  if (artifactKind) clauses.push(`d.artifact_kind = $${params.push(artifactKind)}`);
  if (from) clauses.push(`d.occurred_at >= $${params.push(from)}::timestamptz`);
  if (to) clauses.push(`d.occurred_at < $${params.push(to)}::timestamptz`);
  return clauses.join(' AND ');
}

class ProductionSearchService {
  constructor({ pool, observability = null, statementTimeoutMs = STATEMENT_TIMEOUT_MS, concurrency = null }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pg pool is required');
    this.pool = pool;
    this.observability = observability;
    this.statementTimeoutMs = Math.max(250, Math.min(10000, Number(statementTimeoutMs) || STATEMENT_TIMEOUT_MS));
    this.concurrency = concurrency || new SearchConcurrency();
  }

  async assertProjectAccess({ tenantId, actor, projectId }) {
    const result = await this.pool.query({
      text: `SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.actor_id=$2 AND pm.tenant_id=$1 WHERE p.id=$3 AND p.tenant_id=$1 AND (pm.actor_id IS NOT NULL OR p.created_by=$2) LIMIT 1`,
      values: [tenantId, actor, projectId],
      statement_timeout: this.statementTimeoutMs,
    });
    return Boolean(result.rows[0]);
  }

  async search({ tenantId, actor, params }) {
    if (!this.concurrency.acquire()) throw Object.assign(new Error('Search capacity exhausted'), { code: 'SEARCH_BACKPRESSURE', statusCode: 429 });
    const started = process.hrtime.bigint();
    const values = [];
    let projectId = null;
    try {
      const query = normalizeQuery(params.query);
      const limit = parseLimit(params.limit);
      projectId = params.projectId || null;
      const episodeId = params.episodeId || null;
      const sourceTypes = parseCsv(params.sourceTypes, SOURCE_TYPES, 'sourceTypes');
      const state = params.state ? String(params.state) : null;
      const stage = params.stage ? String(params.stage) : null;
      const provider = params.provider ? String(params.provider).slice(0,128) : null;
      const artifactKind = params.artifactKind ? String(params.artifactKind).slice(0,128) : null;
      if (state && !STATES.has(state)) throw validation('Invalid state');
      if (String(stage || '').length > 128) throw validation('Invalid stage');
      if (projectId && !(await this.assertProjectAccess({ tenantId, actor, projectId }))) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (episodeId) {
        const check = await this.pool.query({ text: `SELECT 1 FROM episodes e JOIN projects p ON p.id=e.project_id LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.actor_id=$2 AND pm.tenant_id=$1 WHERE e.id=$3 AND p.tenant_id=$1 AND (pm.actor_id IS NOT NULL OR p.created_by=$2) LIMIT 1`, values: [tenantId, actor, episodeId], statement_timeout: this.statementTimeoutMs });
        if (!check.rows[0]) throw Object.assign(new Error('Episode not found'), { code: 'NOT_FOUND', statusCode: 404 });
      }
      const from = parseDate(params.from, 'from');
      const to = parseDate(params.to, 'to');
      if (from && to && from >= to) throw validation('from must be before to');
      const cursor = decodeCursor(params.cursor);
      if (query) values.push(query);
      const rankExpr = query ? `ts_rank_cd(d.search_vector, plainto_tsquery('simple',$1))` : '0::real';
      const where = projectScopeWhere({ tenantId, actor, projectId, episodeId, sourceTypes, state, stage, provider, artifactKind, from, to }, values);
      if (query) where += ` AND d.search_vector @@ plainto_tsquery('simple',$1)`;
      if (cursor) {
        values.push(cursor.rank, cursor.updatedAt, cursor.sourceType, cursor.sourceId);
        const rankIndex = values.length - 3;
        where += ` AND (${rankExpr}, d.source_updated_at, d.source_type, d.source_id) < ($${rankIndex}, $${rankIndex+1}::timestamptz, $${rankIndex+2}, $${rankIndex+3})`;
      }
      values.push(limit + 1);
      const limitIndex = values.length;
      const sql = `SELECT d.project_id,d.episode_id,d.source_type,d.source_id,d.title,d.state,d.stage,d.provider,d.artifact_kind,d.occurred_at,d.source_updated_at,d.metadata,${rankExpr} AS relevance FROM forge_search_documents d WHERE ${where} ORDER BY relevance DESC,d.source_updated_at DESC,d.source_type ASC,d.source_id ASC LIMIT $${limitIndex}`;
      const result = await this.pool.query({ text: sql, values, statement_timeout: this.statementTimeoutMs });
      const items = result.rows.slice(0, limit);
      const hasMore = result.rows.length > limit;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ rank: Number(last.relevance), updatedAt: new Date(last.source_updated_at).toISOString(), sourceType: last.source_type, sourceId: last.source_id }) : null;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.observability?.metrics?.inc?.('forge_search_queries_total', { outcome: 'success' });
      this.observability?.metrics?.observe?.('forge_search_query_duration_ms', durationMs, { outcome: 'success' });
      await this.recordStat({ tenantId, projectId, query, resultCount: items.length, durationMs, timedOut: false, cancelled: false });
      return { items, page: { limit, nextCursor, hasMore }, index: { schemaVersion: 1 } };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const timedOut = error?.code === '57014' || /statement timeout/i.test(error?.message || '');
      const cancelled = Boolean(error?.code === '57014' && /cancel/i.test(error?.message || ''));
      this.observability?.metrics?.inc?.('forge_search_queries_total', { outcome: timedOut ? 'timeout' : error?.code === 'SEARCH_BACKPRESSURE' ? 'backpressure' : 'error' });
      if (error?.statusCode === 429) throw error;
      await this.recordStat({ tenantId, projectId, query: String(params.query || '').slice(0, MAX_QUERY_LENGTH), resultCount: 0, durationMs, timedOut, cancelled }).catch(() => {});
      if (timedOut) throw Object.assign(new Error('Search query timed out'), { code: 'SEARCH_TIMEOUT', statusCode: 503 });
      throw error;
    } finally { this.concurrency.release(); }
  }

  async recordStat({ tenantId, projectId, query, resultCount, durationMs, timedOut, cancelled }) {
    const queryHash = crypto.createHash('sha256').update(query || '').digest('hex');
    await this.pool.query({ text: `INSERT INTO forge_search_query_stats(tenant_id,project_id,query_hash,result_count,duration_ms,timed_out,cancelled) VALUES($1,$2,$3,$4,$5,$6,$7)`, values: [tenantId, projectId, queryHash, resultCount, Math.round(durationMs), timedOut, cancelled], statement_timeout: this.statementTimeoutMs });
  }

  async createRebuild({ tenantId, actor, projectId = null }) {
    if (projectId && !(await this.assertProjectAccess({ tenantId, actor, projectId }))) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND', statusCode: 404 });
    const id = `search-rebuild:${crypto.randomUUID()}`;
    const result = await this.pool.query({ text: `INSERT INTO forge_search_rebuilds(id,tenant_id,project_id,state,schema_version,created_by) VALUES($1,$2,$3,'QUEUED',1,$4) RETURNING *`, values: [id, tenantId, projectId, actor], statement_timeout: this.statementTimeoutMs });
    await this.pool.query({ text: `UPDATE forge_search_index_meta SET state='REBUILDING',updated_at=now() WHERE singleton`, values: [], statement_timeout: this.statementTimeoutMs });
    return result.rows[0];
  }

  async rebuildBatch({ tenantId, actor, rebuildId, limit = 100 }) {
    const batchSize = Math.min(100, parseLimit(limit));
    const jobResult = await this.pool.query({ text: `SELECT * FROM forge_search_rebuilds WHERE id=$1 AND tenant_id=$2`, values: [rebuildId, tenantId], statement_timeout: this.statementTimeoutMs });
    const job = jobResult.rows[0];
    if (!job) throw Object.assign(new Error('Rebuild not found'), { code: 'NOT_FOUND', statusCode: 404 });
    if (job.project_id && !(await this.assertProjectAccess({ tenantId, actor, projectId: job.project_id }))) throw Object.assign(new Error('Rebuild not found'), { code: 'NOT_FOUND', statusCode: 404 });
    if (['SUCCEEDED','CANCELLED'].includes(job.state)) return job;
    const types = ['project','episode','version','artifact','job','provider_run','approval','qa','publish_run','cost','audit_event'];
    let typeIndex = job.cursor_type ? Math.max(0, types.indexOf(job.cursor_type)) : 0;
    let cursorId = job.cursor_id || '';
    let processed = 0;
    for (; typeIndex < types.length && processed < batchSize; typeIndex += 1) {
      const type = types[typeIndex];
      const remaining = batchSize - processed;
      const rows = await this._sourceBatch(type, tenantId, job.project_id, cursorId, remaining);
      for (const row of rows) {
        await this.pool.query({ text: `SELECT forge_search_refresh_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, values: [row.project_id,row.tenant_id,type,row.source_id,row.episode_id,row.title,row.content,row.state,row.stage,row.provider,row.artifact_kind,row.occurred_at,row.source_updated_at,row.metadata], statement_timeout: this.statementTimeoutMs });
        processed += 1;
      }
      if (rows.length < remaining) { cursorId = ''; } else { cursorId = rows[rows.length - 1].source_id; break; }
    }
    const finished = typeIndex >= types.length;
    const result = await this.pool.query({ text: `UPDATE forge_search_rebuilds SET state=$1,cursor_type=$2,cursor_id=$3,processed=processed+$4,updated_at=now(),started_at=COALESCE(started_at,now()),finished_at=CASE WHEN $1='SUCCEEDED' THEN now() ELSE finished_at END WHERE id=$5 AND tenant_id=$6 RETURNING *`, values: [finished ? 'SUCCEEDED' : 'RUNNING', finished ? null : types[typeIndex], finished ? null : cursorId, processed, rebuildId, tenantId], statement_timeout: this.statementTimeoutMs });
    if (finished) {
      await this.reconcile({ tenantId, actor, projectId: job.project_id, limit: 100 });
      await this.pool.query({ text: `UPDATE forge_search_index_meta SET state='READY',updated_at=now() WHERE singleton`, values: [], statement_timeout: this.statementTimeoutMs });
    }
    return result.rows[0];
  }

  async _sourceBatch(type, tenantId, projectId, cursorId, limit) {
    const params = [tenantId, projectId || null, cursorId || '', limit];
    const scope = `p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)`;
    const queries = {
      project: `SELECT p.id project_id,p.tenant_id,NULL::text episode_id,p.id source_id,p.name title,left(coalesce(p.metadata,'{}')::text,16000) content,NULL state,NULL stage,NULL provider,NULL artifact_kind,p.created_at occurred_at,p.updated_at source_updated_at,coalesce(p.metadata,'{}') metadata FROM projects p WHERE ${scope} AND p.id>$3 ORDER BY p.id LIMIT $4`,
      episode: `SELECT e.project_id,p.tenant_id,e.id episode_id,e.id source_id,e.title,left(e.description,16000) content,e.state,NULL,NULL,NULL,e.created_at,e.updated_at,coalesce(e.metadata,'{}') FROM episodes e JOIN projects p ON p.id=e.project_id WHERE ${scope} AND e.id>$3 ORDER BY e.id LIMIT $4`,
      version: `SELECT e.project_id,p.tenant_id,v.episode_id,v.id source_id,v.kind,v.payload::text,NULL,NULL,NULL,NULL,v.created_at,v.created_at,coalesce(v.payload,'{}') FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND v.id>$3 ORDER BY v.id LIMIT $4`,
      artifact: `SELECT e.project_id,p.tenant_id,a.episode_id,a.id source_id,a.kind,a.content_hash||' '||coalesce(a.source,''),NULL,NULL,NULL,a.kind,a.created_at,a.created_at,coalesce(a.metadata,'{}') FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND a.id>$3 ORDER BY a.id LIMIT $4`,
      job: `SELECT coalesce(j.project_id,e.project_id) project_id,p.tenant_id,j.episode_id,j.id source_id,j.kind||' '||j.status,left(coalesce(j.error,'{}')::text,12000),j.status,NULL,NULL,NULL,j.created_at,j.updated_at,jsonb_build_object('priority',j.priority,'attempts',j.attempts) FROM forge_jobs j LEFT JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=coalesce(j.project_id,e.project_id) WHERE ${scope} AND j.id>$3 ORDER BY j.id LIMIT $4`,
      provider_run: `SELECT e.project_id,p.tenant_id,r.episode_id,r.id source_id,r.capability||' '||r.provider||' '||coalesce(r.model,''),left(coalesce(r.error,'{}')::text,6000),r.status,NULL,r.provider,NULL,r.created_at,coalesce(r.finished_at,r.started_at,r.created_at),jsonb_build_object('attempt',r.attempt) FROM provider_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND r.id>$3 ORDER BY r.id LIMIT $4`,
      approval: `SELECT e.project_id,p.tenant_id,a.episode_id,a.id::text source_id,a.stage||' '||a.decision,a.actor||' '||left(a.comments,6000),a.decision,a.stage,NULL,NULL,a.decided_at,a.decided_at,coalesce(a.evidence,'{}') FROM approvals a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND a.id::text>$3 ORDER BY a.id::text LIMIT $4`,
      qa: `SELECT e.project_id,p.tenant_id,q.episode_id,q.id source_id,q.status||' '||q.runner,left(coalesce(q.checks,'[]')::text,12000),q.status,NULL,NULL,NULL,q.created_at,q.created_at,coalesce(q.metadata,'{}') FROM qa_results q JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND q.id>$3 ORDER BY q.id LIMIT $4`,
      publish_run: `SELECT e.project_id,p.tenant_id,r.episode_id,r.id source_id,r.destination||' '||r.status,r.external_id||' '||coalesce(r.external_url,''),r.status,NULL,NULL,NULL,r.created_at,coalesce(r.finished_at,r.started_at,r.created_at),coalesce(r.metadata,'{}') FROM publish_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND r.id>$3 ORDER BY r.id LIMIT $4`,
      cost: `SELECT e.project_id,p.tenant_id,c.episode_id,c.id source_id,c.provider||' '||c.operation,coalesce(c.model,'')||' '||coalesce(c.currency,''),NULL,NULL,c.provider,NULL,c.created_at,c.created_at,coalesce(c.metadata,'{}') FROM cost_records c JOIN episodes e ON e.id=c.episode_id JOIN projects p ON p.id=e.project_id WHERE ${scope} AND c.id>$3 ORDER BY c.id LIMIT $4`,
      audit_event: `SELECT coalesce(a.project_id,e.project_id) project_id,p.tenant_id,a.episode_id,a.id::text source_id,a.action||' '||a.target_type,a.actor||' '||a.target_id,NULL,NULL,NULL,NULL,a.created_at,a.created_at,coalesce(a.details,'{}') FROM audit_events a LEFT JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=coalesce(a.project_id,e.project_id) WHERE ${scope} AND a.id::text>$3 ORDER BY a.id LIMIT $4`,
    };
    const sql = queries[type];
    if (!sql) return [];
    const result = await this.pool.query({ text: sql, values: params, statement_timeout: this.statementTimeoutMs });
    return result.rows.map(r => ({ project_id:r.project_id,tenant_id:r.tenant_id,episode_id:r.episode_id,source_id:r.source_id,title:r.title || '',content:r.content || '',state:r.state,stage:r.stage,provider:r.provider,artifact_kind:r.artifact_kind,occurred_at:r.occurred_at,source_updated_at:r.source_updated_at,metadata:r.metadata || {} }));
  }

  async reconcile({ tenantId, actor, projectId = null, limit = 100 }) {
    if (projectId && !(await this.assertProjectAccess({ tenantId, actor, projectId }))) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND', statusCode: 404 });
    const params = [tenantId, projectId, Math.min(100, parseLimit(limit))];
    const result = await this.pool.query({ text: `WITH expected AS (
      SELECT p.id project_id,'project' source_type,p.id source_id FROM projects p WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'episode',e.id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'version',v.id FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'artifact',a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT coalesce(j.project_id,e.project_id),'job',j.id FROM forge_jobs j LEFT JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=coalesce(j.project_id,e.project_id) WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'provider_run',r.id FROM provider_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'approval',a.id::text FROM approvals a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'qa',q.id FROM qa_results q JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'publish_run',r.id FROM publish_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT e.project_id,'cost',c.id FROM cost_records c JOIN episodes e ON e.id=c.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
      UNION ALL SELECT coalesce(a.project_id,e.project_id),'audit_event',a.id::text FROM audit_events a LEFT JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=coalesce(a.project_id,e.project_id) WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    ), missing AS (SELECT d.project_id,d.source_type,d.source_id FROM forge_search_documents d LEFT JOIN expected x ON x.project_id=d.project_id AND x.source_type=d.source_type AND x.source_id=d.source_id WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.project_id=$2) AND x.source_id IS NULL LIMIT $3)
    DELETE FROM forge_search_documents d USING missing m WHERE d.project_id=m.project_id AND d.source_type=m.source_type AND d.source_id=m.source_id RETURNING d.source_id`, values: params, statement_timeout: this.statementTimeoutMs });
    const drift = result.rowCount || 0;
    await this.pool.query({ text:`UPDATE forge_search_index_meta SET last_reconciled_at=now(),last_reconcile_drift=$1,updated_at=now() WHERE singleton`, values:[drift], statement_timeout:this.statementTimeoutMs });
    this.observability?.metrics?.set?.('forge_search_index_drift', drift);
    return { driftDeleted: drift, checkedAt: new Date().toISOString() };
  }

  async health({ tenantId = null } = {}) {
    const meta = await this.pool.query({ text:`SELECT schema_version,state,updated_at,last_reconciled_at,last_reconcile_drift FROM forge_search_index_meta WHERE singleton`, values:[], statement_timeout:this.statementTimeoutMs });
    const lag = await this.pool.query({ text:`SELECT count(*)::int AS stale FROM forge_search_documents d JOIN projects p ON p.id=d.project_id WHERE ($1::text IS NULL OR p.tenant_id=$1) AND d.indexed_at < d.source_updated_at`, values:[tenantId], statement_timeout:this.statementTimeoutMs });
    const rebuilds = await this.pool.query({ text:`SELECT count(*)::int AS active FROM forge_search_rebuilds WHERE state IN ('QUEUED','RUNNING') AND ($1::text IS NULL OR tenant_id=$1)`, values:[tenantId], statement_timeout:this.statementTimeoutMs });
    return { status: meta.rows[0]?.state === 'READY' && Number(lag.rows[0]?.stale || 0) === 0 ? 'ok' : 'degraded', schemaVersion: meta.rows[0]?.schema_version || 0, state: meta.rows[0]?.state || 'UNKNOWN', staleEntries: Number(lag.rows[0]?.stale || 0), activeRebuilds: Number(rebuilds.rows[0]?.active || 0), lastReconciledAt: meta.rows[0]?.last_reconciled_at || null, drift: Number(meta.rows[0]?.last_reconcile_drift || 0) };
  }
}

async function handleSearchRequest(request, response, { pool, auth, observability, service }) {
  const { URL } = require('node:url');
  const { randomUUID } = require('node:crypto');
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname.split('/').filter(Boolean);
  const requestId = request.headers['x-request-id'] || randomUUID();
  const send = (status, body) => { response.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); response.end(JSON.stringify({ ...body, requestId })); };
  try {
    if (request.method === 'GET' && url.pathname === '/v1/search/health') return send(200, await service.health({ tenantId: auth.tenantId }));
    if (request.method === 'GET' && url.pathname === '/v1/search') return send(200, await service.search({ tenantId: auth.tenantId, actor: auth.actor, params: Object.fromEntries(url.searchParams.entries()) }));
    if (request.method === 'POST' && url.pathname === '/v1/search/rebuilds') {
      let body=''; for await (const chunk of request) { body += chunk; if (body.length > 16384) throw Object.assign(new Error('Request body too large'),{statusCode:413}); }
      const parsed = body ? JSON.parse(body) : {};
      if (!hasOwner(auth)) throw Object.assign(new Error('Forbidden'),{statusCode:403,code:'FORBIDDEN'});
      return send(202, { item: await service.createRebuild({ tenantId:auth.tenantId,actor:auth.actor,projectId:parsed.projectId || null }) });
    }
    if (request.method === 'POST' && path[0]==='v1' && path[1]==='search' && path[2]==='rebuilds' && path[3] && path[4]==='run') {
      if (!hasOwner(auth)) throw Object.assign(new Error('Forbidden'),{statusCode:403,code:'FORBIDDEN'});
      return send(200, { item: await service.rebuildBatch({ tenantId:auth.tenantId,actor:auth.actor,rebuildId:decodeURIComponent(path[3]),limit:url.searchParams.get('limit') || 100 }) });
    }
    if (request.method === 'POST' && path[0]==='v1' && path[1]==='search' && path[2]==='reconcile') {
      if (!hasOwner(auth)) throw Object.assign(new Error('Forbidden'),{statusCode:403,code:'FORBIDDEN'});
      return send(200, { item: await service.reconcile({ tenantId:auth.tenantId,actor:auth.actor,projectId:url.searchParams.get('projectId') || null,limit:url.searchParams.get('limit') || 100 }) });
    }
    if (request.method === 'GET' && path[0]==='v1' && path[1]==='search' && path[2]==='rebuilds' && path[3]) {
      const result = await pool.query({ text:`SELECT id,state,schema_version,cursor_type,cursor_id,processed,inserted,deleted,drift_found,last_error,created_by,created_at,started_at,finished_at,updated_at FROM forge_search_rebuilds WHERE id=$1 AND tenant_id=$2`, values:[decodeURIComponent(path[3]),auth.tenantId], statement_timeout:service.statementTimeoutMs });
      if (!result.rows[0]) return send(404,{error:{code:'NOT_FOUND',message:'Rebuild not found'}});
      if (!hasOwner(auth) && result.rows[0].created_by!==auth.actor) return send(404,{error:{code:'NOT_FOUND',message:'Rebuild not found'}});
      return send(200,{item:result.rows[0]});
    }
    return send(404,{error:{code:'NOT_FOUND',message:'Route not found'}});
  } catch (error) {
    const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
    const code = error.code || (status===400?'VALIDATION_ERROR':'INTERNAL_ERROR');
    if (status >= 500) observability?.log?.('error',{event:'search.request_failed',requestId,code});
    return send(status,{error:{code,message: status>=500 ? 'Search service unavailable' : error.message}});
  }
}
function hasOwner(auth) { return Array.isArray(auth.roles) && auth.roles.includes('OWNER'); }

module.exports = { ProductionSearchService, SearchConcurrency, handleSearchRequest, encodeCursor, decodeCursor, normalizeQuery, parseLimit };
