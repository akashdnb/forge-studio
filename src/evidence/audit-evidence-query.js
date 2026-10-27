const { createHash } = require('node:crypto');

const MAX_LIMIT = 500;
const MAX_VERIFY = 100_000;

function encodeCursor(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decodeCursor(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (!parsed || !parsed.occurredAt || !Number.isInteger(parsed.ledgerSeq) || !parsed.eventId) throw new Error(); return parsed; }
  catch { throw Object.assign(new Error('Invalid evidence cursor'), { code: 'INVALID_CURSOR', statusCode: 400 }); }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error('Invalid numeric evidence parameter'), { code: 'INVALID_REQUEST', statusCode: 400 });
  return n;
}

class AuditEvidenceQueryService {
  constructor({ pool, logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.logger = logger;
  }

  async search({ tenantId, requestActor = null, projectId = null, actor = null, serviceIdentity = null, eventClass = null, sourceTable = null, operation = null, targetType = null, targetId = null, requestId = null, correlationId = null, causationId = null, eventId = null, from = null, to = null, includeArchived = false, privileged = false, limit = 100, cursor = null } = {}) {
    if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'TENANT_REQUIRED', statusCode: 403 });
    const size = boundedInteger(limit, 100, 1, MAX_LIMIT);
    const decoded = decodeCursor(cursor);
    const values = [tenantId];
    const where = ['e.tenant_id = $1'];
    const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (projectId) add('e.project_id = ?', projectId);
    if (actor) add('e.actor = ?', actor);
    if (serviceIdentity) add('e.service_identity = ?', serviceIdentity);
    if (eventClass) add('e.event_class = ?', eventClass);
    if (sourceTable) add('e.source_table = ?', sourceTable);
    if (operation) add('e.operation = ?', operation);
    if (targetType) add('e.target_type = ?', targetType);
    if (targetId) add('e.target_id = ?', targetId);
    if (requestId) add('e.request_id = ?', requestId);
    if (correlationId) add('e.correlation_id = ?', correlationId);
    if (causationId) add('e.causation_id = ?', causationId);
    if (eventId) add('e.event_id = ?', eventId);
    if (from) add('e.occurred_at >= ?', from);
    if (to) add('e.occurred_at < ?', to);
    if (!privileged && requestActor) {
      values.push(requestActor);
      const actorParam = values.length;
      where.push(`(e.project_id IS NULL OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=e.project_id AND pm.actor_id=$${actorParam}) OR EXISTS (SELECT 1 FROM projects pp WHERE pp.id=e.project_id AND pp.tenant_id=e.tenant_id AND pp.created_by=$${actorParam}))`);
    }
    if (!includeArchived) {
      where.push("e.retention_state NOT IN ('ARCHIVED','EXPIRED','QUARANTINED')");
      where.push("NOT EXISTS (SELECT 1 FROM evidence_archive_events ae WHERE ae.tenant_id=e.tenant_id AND ae.ledger_seq=e.ledger_seq)");
    }
    where.push("NOT EXISTS (SELECT 1 FROM privacy_retention_items ri WHERE ri.tenant_id=e.tenant_id AND ri.resource_type='audit_evidence' AND ri.resource_id=e.event_id AND ri.state IN ('ELIGIBLE','APPROVED','DESTROYED') AND ri.eligible_at <= now())");
    where.push("NOT EXISTS (SELECT 1 FROM privacy_quarantine pq WHERE pq.tenant_id=e.tenant_id AND pq.resource_type='audit_evidence' AND pq.resource_id=e.event_id AND pq.state='PURGED')");
    if (!privileged) where.push("e.redaction_level <> 'RESTRICTED'");
    if (decoded) {
      const occurredParam = values.length + 1;
      values.push(decoded.occurredAt, decoded.ledgerSeq, decoded.eventId);
      where.push(`(e.occurred_at < $${occurredParam} OR (e.occurred_at = $${occurredParam} AND e.ledger_seq < $${occurredParam + 1}) OR (e.occurred_at = $${occurredParam} AND e.ledger_seq = $${occurredParam + 1} AND e.event_id < $${occurredParam + 2}))`);
    }
    values.push(size + 1);
    const sql = `SELECT e.*, EXISTS (SELECT 1 FROM privacy_holds h WHERE h.active AND h.tenant_id=e.tenant_id AND (h.project_id IS NULL OR h.project_id=e.project_id)) AS live_legal_hold FROM evidence_search_index e WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC, e.ledger_seq DESC, e.event_id DESC LIMIT $${values.length}`;
    const rows = (await this.pool.query(sql, values)).rows;
    const page = rows.slice(0, size).map((row) => this.redact(row, privileged));
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > size && last ? encodeCursor({ occurredAt: last.occurred_at, ledgerSeq: Number(last.ledger_seq), eventId: last.event_id }) : null };
  }

  redact(row, privileged) {
    const item = { ...row };
    delete item.indexed_at;
    if (!privileged) {
      delete item.service_identity;
      if (item.redaction_level !== 'STANDARD') item.actor = 'redacted';
      delete item.request_id;
      delete item.correlation_id;
      delete item.causation_id;
    }
    return item;
  }

  async inspect({ tenantId, requestActor = null, eventId, privileged = false } = {}) {
    if (!tenantId || !eventId) throw Object.assign(new Error('tenantId and eventId are required'), { code: 'INVALID_REQUEST', statusCode: 400 });
    const result = await this.search({ tenantId, requestActor, eventId, privileged, limit: 1, includeArchived: false });
    return result.items[0] || null;
  }

  async retentionStatus({ tenantId, eventId = null, projectId = null } = {}) {
    if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'TENANT_REQUIRED', statusCode: 403 });
    const values = [tenantId];
    const filters = ['e.tenant_id=$1'];
    if (eventId) { values.push(eventId); filters.push(`e.event_id=$${values.length}`); }
    if (projectId) { values.push(projectId); filters.push(`e.project_id=$${values.length}`); }
    const policy = (await this.pool.query('SELECT * FROM evidence_retention_policy WHERE tenant_id=$1', [tenantId])).rows[0] || null;
    const holds = (await this.pool.query('SELECT id,project_id,reason,active,created_by,created_at,released_at FROM privacy_holds WHERE tenant_id=$1 AND active ORDER BY created_at DESC', [tenantId])).rows;
    const summary = (await this.pool.query(`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER(WHERE e.retention_state='ARCHIVED')::bigint AS archived, COUNT(*) FILTER(WHERE e.retention_state='EXPIRED')::bigint AS expired, COUNT(*) FILTER(WHERE e.retention_state='QUARANTINED')::bigint AS quarantined, COUNT(*) FILTER(WHERE EXISTS (SELECT 1 FROM privacy_holds h WHERE h.active AND h.tenant_id=e.tenant_id AND (h.project_id IS NULL OR h.project_id=e.project_id)))::bigint AS held FROM evidence_search_index e WHERE ${filters.join(' AND ')}`, values)).rows[0];
    return { policy, holds, summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Number(v)])) };
  }

  async verify({ tenantId, fromSeq = null, toSeq = null, fullChain = false, maxEvents = 10000 } = {}) {
    if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'TENANT_REQUIRED', statusCode: 403 });
    const bound = boundedInteger(maxEvents, 10000, 1, MAX_VERIFY);
    const head = (await this.pool.query('SELECT chain_head_seq,chain_head_hash FROM forge_evidence_chain_state WHERE id=1')).rows[0] || { chain_head_seq: 0, chain_head_hash: '0'.repeat(64) };
    const upper = toSeq == null ? Number(head.chain_head_seq) : boundedInteger(toSeq, Number(head.chain_head_seq), 0, Number.MAX_SAFE_INTEGER);
    const lower = fromSeq == null ? (fullChain ? 1 : Math.max(1, upper - bound + 1)) : boundedInteger(fromSeq, 1, 1, Number.MAX_SAFE_INTEGER);
    if (lower > upper) return { ok: true, checked: 0, selectedCount: 0, issues: [], fromSeq: lower, toSeq: upper };
    const selected = (await this.pool.query('SELECT e.* FROM evidence_ledger e WHERE e.tenant_id=$1 AND e.ledger_seq BETWEEN $2 AND $3 ORDER BY e.ledger_seq LIMIT $4', [tenantId, lower, upper, bound + 1])).rows;
    const issues = [];
    if (selected.length > bound) issues.push({ code: 'SCAN_BOUND_REACHED', maxEvents: bound });
    const rows = selected.slice(0, bound);
    const globalRows = (await this.pool.query('SELECT ledger_seq,event_id,tenant_id,prev_hash,event_hash FROM evidence_ledger WHERE ledger_seq BETWEEN $1 AND $2 ORDER BY ledger_seq', [Math.max(1, lower - 1), upper])).rows;
    const bySeq = new Map(globalRows.map((r) => [Number(r.ledger_seq), r]));
    let previousOccurred = null;
    for (const row of rows) {
      const seq = Number(row.ledger_seq);
      const expected = sha256([row.ledger_seq,row.event_id,row.prev_hash,row.tenant_id || '',row.project_id || '',row.episode_id || '',row.actor,row.source_table,row.operation,row.target_id,row.request_id || '',row.causal_event_id || '',row.payload_digest].join('|'));
      const previousGlobal = bySeq.get(seq - 1) || null;
      if (expected !== row.event_hash) issues.push({ code: 'CHAIN_HASH_MISMATCH', ledgerSeq: seq, eventId: row.event_id });
      if (previousGlobal && row.prev_hash !== previousGlobal.event_hash) issues.push({ code: 'CHAIN_BREAK', ledgerSeq: seq, eventId: row.event_id });
      if (!previousGlobal && seq > 1) issues.push({ code: 'SEQUENCE_GAP', ledgerSeq: seq, eventId: row.event_id });
      if (previousOccurred !== null && new Date(row.occurred_at).getTime() > previousOccurred) issues.push({ code: 'CLOCK_REORDER', ledgerSeq: seq, eventId: row.event_id });
      previousOccurred = new Date(row.occurred_at).getTime();
    }
    const duplicates = (await this.pool.query('SELECT event_id,COUNT(*)::int AS count FROM evidence_ledger WHERE tenant_id=$1 GROUP BY event_id HAVING COUNT(*)>1 LIMIT 20', [tenantId])).rows;
    for (const duplicate of duplicates) issues.push({ code: 'DUPLICATE_EVENT_ID', eventId: duplicate.event_id, count: duplicate.count });
    const result = { ok: issues.length === 0, checked: rows.length, selectedCount: rows.length, issues, fromSeq: lower, toSeq: upper, chainHeadHash: head.chain_head_hash };
    await this.pool.query('INSERT INTO evidence_integrity_runs(tenant_id,from_seq,to_seq,checked,issue_count,status,issues,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now())', [tenantId, lower, upper, result.checked, issues.length, issues.length ? 'FAILED' : 'PASSED', JSON.stringify(issues)]);
    return result;
  }

  async diagnostics({ tenantId, scanLimit = 5000 } = {}) {
    const verification = await this.verify({ tenantId, maxEvents: boundedInteger(scanLimit, 5000, 1, MAX_VERIFY) });
    const retention = await this.retentionStatus({ tenantId });
    return { status: verification.ok ? 'ok' : 'degraded', verification, retention };
  }

  async controlledExport({ tenantId, actor, privileged = false, projectId = null, from = null, to = null, limit = 5000 } = {}) {
    const result = await this.search({ tenantId, requestActor: actor, projectId, from, to, privileged, includeArchived: false, limit: Math.min(limit, 500) });
    const body = result.items.map((row) => JSON.stringify(row)).join('\n') + (result.items.length ? '\n' : '');
    const exportHash = sha256(body);
    await this.pool.query('INSERT INTO evidence_export_audit(tenant_id,project_id,actor,privileged,from_seq,to_seq,event_count,export_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, projectId, actor || 'system', privileged, result.items[0]?.ledger_seq || null, result.items.at(-1)?.ledger_seq || null, result.items.length, exportHash]);
    return { body, exportHash, eventCount: result.items.length, nextCursor: result.nextCursor };
  }
}

module.exports = { AuditEvidenceQueryService, encodeCursor, decodeCursor, boundedInteger, sha256 };
