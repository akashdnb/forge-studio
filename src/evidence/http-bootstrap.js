const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { AuditEvidenceQueryService, boundedInteger } = require('./audit-evidence-query');
const { archiveEvidence } = require('./audit-evidence-archive');
const { authenticate, hasRole, csrfAllowed } = require('../security/http-security');

if (process.env.DATABASE_URL && !http.Server.prototype.__forgeEvidenceQueryPatched) {
  http.Server.prototype.__forgeEvidenceQueryPatched = true;
  let poolPromise = null;
  const buckets = new Map();
  const getPool = async () => {
    if (!poolPromise) poolPromise = (async () => {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, application_name: 'forge-evidence-query' });
      await pool.query('SELECT 1');
      return pool;
    })();
    return poolPromise;
  };
  const send = (res, status, body, requestId) => {
    if (res.headersSent) return;
    res.setHeader('x-request-id', requestId);
    res.setHeader('cache-control', 'no-store');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const rateAllowed = (key) => {
    const now = Date.now();
    const current = buckets.get(key) || { start: now, count: 0 };
    if (now - current.start >= 60000) { current.start = now; current.count = 0; }
    current.count += 1;
    buckets.set(key, current);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.start > 60000) buckets.delete(k);
    return current.count <= Number(process.env.FORGE_EVIDENCE_RATE_LIMIT_PER_MINUTE || 60);
  };
  const evidencePath = (pathname) => pathname.startsWith('/v1/evidence/') || pathname.startsWith('/internal/evidence/');

  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function forgeEvidenceEmit(event, request, response) {
    if (event !== 'request' || !request || !evidencePath(new URL(request.url || '/', 'http://localhost').pathname)) return originalEmit.apply(this, arguments);
    const requestId = request.headers['x-request-id'] || randomUUID();
    const url = new URL(request.url || '/', 'http://localhost');
    Promise.resolve().then(async () => {
      try {
        const auth = authenticate(request, {
          apiToken: process.env.API_BEARER_TOKEN || null,
          authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null,
          staticActor: process.env.FORGE_STATIC_ACTOR_ID || null,
          staticTenant: process.env.FORGE_STATIC_TENANT_ID || null,
        });
        if (!auth || !auth.tenantId || !hasRole(auth, 'VIEWER')) return send(response, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const origins = new Set((process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean));
        if (!csrfAllowed(request, origins)) return send(response, 403, { error: { code: 'CSRF_BLOCKED' } }, requestId);
        if (!rateAllowed(`${auth.tenantId}:${auth.actor}`)) return send(response, 429, { error: { code: 'RATE_LIMITED' } }, requestId);
        const service = new AuditEvidenceQueryService({ pool: await getPool() });
        const privileged = hasRole(auth, 'OWNER');
        const p = url.pathname;
        if (p === '/v1/evidence/search' && request.method === 'GET') {
          const item = await service.search({ tenantId: auth.tenantId, projectId: url.searchParams.get('projectId') || null, actor: url.searchParams.get('actor') || null, serviceIdentity: url.searchParams.get('serviceIdentity') || null, eventClass: url.searchParams.get('eventClass') || null, sourceTable: url.searchParams.get('sourceTable') || null, operation: url.searchParams.get('operation') || null, targetType: url.searchParams.get('targetType') || null, targetId: url.searchParams.get('targetId') || null, requestId: url.searchParams.get('requestId') || null, correlationId: url.searchParams.get('correlationId') || null, causationId: url.searchParams.get('causationId') || null, eventId: url.searchParams.get('eventId') || null, from: url.searchParams.get('from') || null, to: url.searchParams.get('to') || null, cursor: url.searchParams.get('cursor') || null, limit: boundedInteger(url.searchParams.get('limit'), 100, 1, 500), privileged });
          return send(response, 200, item, requestId);
        }
        const eventMatch = /^\/v1\/evidence\/events\/([^/]+)$/.exec(p);
        if (eventMatch && request.method === 'GET') return send(response, 200, { item: await service.inspect({ tenantId: auth.tenantId, eventId: decodeURIComponent(eventMatch[1]), privileged }) }, requestId);
        if (p === '/v1/evidence/verify' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          const result = await service.verify({ tenantId: auth.tenantId, fromSeq: url.searchParams.get('fromSeq'), toSeq: url.searchParams.get('toSeq'), fullChain: url.searchParams.get('fullChain') === 'true', maxEvents: boundedInteger(url.searchParams.get('maxEvents'), 10000, 1, 100000) });
          return send(response, result.ok ? 200 : 409, { item: result }, requestId);
        }
        if (p === '/v1/evidence/diagnostics' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          return send(response, 200, await service.diagnostics({ tenantId: auth.tenantId, scanLimit: boundedInteger(url.searchParams.get('scanLimit'), 5000, 1, 100000) }), requestId);
        }
        if (p === '/v1/evidence/retention' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          return send(response, 200, { item: await service.retentionStatus({ tenantId: auth.tenantId, eventId: url.searchParams.get('eventId') || null, projectId: url.searchParams.get('projectId') || null }) }, requestId);
        }
        if (p === '/v1/evidence/export' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          const result = await service.controlledExport({ tenantId: auth.tenantId, actor: auth.actor, privileged, projectId: url.searchParams.get('projectId') || null, from: url.searchParams.get('from') || null, to: url.searchParams.get('to') || null, limit: boundedInteger(url.searchParams.get('limit'), 500, 1, 500) });
          response.setHeader('x-evidence-checksum', result.exportHash); response.setHeader('x-evidence-event-count', String(result.eventCount)); response.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); response.setHeader('cache-control', 'no-store'); response.writeHead(200); return response.end(result.body);
        }
        if (p === '/internal/evidence/archive' && request.method === 'POST') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          const payload = await new Promise((resolve, reject) => { let data = ''; request.on('data', (chunk) => { data += chunk; if (Buffer.byteLength(data) > 64 * 1024) reject(Object.assign(new Error('Payload too large'), { statusCode: 413 })); }); request.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('Malformed JSON'), { statusCode: 400 })); } }); request.on('error', reject); });
          return send(response, 201, { item: await archiveEvidence({ pool: await getPool(), tenantId: auth.tenantId, fromSeq: payload.fromSeq || 0, toSeq: payload.toSeq == null ? null : payload.toSeq }) }, requestId);
        }
        if (p === '/internal/evidence/metrics' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          const [ledger, head, failures] = await Promise.all([
            service.pool.query('SELECT COUNT(*)::bigint AS count,COALESCE(MAX(ledger_seq),0)::bigint AS max_seq FROM evidence_ledger WHERE tenant_id=$1', [auth.tenantId]),
            service.pool.query('SELECT chain_head_seq,chain_head_hash,updated_at FROM forge_evidence_chain_state WHERE id=1'),
            service.pool.query("SELECT COUNT(*)::bigint AS count FROM evidence_integrity_runs WHERE tenant_id=$1 AND status='FAILED'", [auth.tenantId]),
          ]);
          return send(response, 200, { metrics: { evidence_events_total: Number(ledger.rows[0].count), evidence_tenant_max_seq: Number(ledger.rows[0].max_seq), evidence_chain_head_seq: Number(head.rows[0]?.chain_head_seq || 0), evidence_chain_head_hash: head.rows[0]?.chain_head_hash || null, evidence_integrity_failures_total: Number(failures.rows[0].count) } }, requestId);
        }
        if (p === '/internal/evidence/hold-status' && request.method === 'GET') {
          if (!privileged) return send(response, 403, { error: { code: 'OWNER_REQUIRED' } }, requestId);
          return send(response, 200, { item: await service.retentionStatus({ tenantId: auth.tenantId }) }, requestId);
        }
        return send(response, 404, { error: { code: 'NOT_FOUND' } }, requestId);
      } catch (error) {
        send(response, error.statusCode || (error.code === 'FORBIDDEN' ? 403 : error.code === 'INVALID_CURSOR' ? 400 : 500), { error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }, requestId);
      }
    });
    return true;
  };
}
