const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { ProductionService } = require('./domain/production-service');
const JSON_LIMIT_BYTES = 1024 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_ROUTES = new Set(['GET /healthz', 'GET /readyz', 'GET /openapi.json']);
function send(response, statusCode, body) { response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); response.end(JSON.stringify(body)); }
async function readJson(request) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > JSON_LIMIT_BYTES) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 }); chunks.push(chunk); } if (!size) return {}; try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object'); return parsed; } catch (cause) { throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400, cause }); } }
function tokenMatches(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a = Buffer.from(expected); const b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
function authorize(request, { apiToken, allowUnauthenticatedRead = false }) { const method = request.method || 'GET'; const url = new URL(request.url || '/', 'http://localhost'); if (PUBLIC_ROUTES.has(`${method} ${url.pathname}`)) return { ok: true, actor: 'system-health' }; if (!apiToken) { if (MUTATING_METHODS.has(method)) return { ok: false }; return allowUnauthenticatedRead ? { ok: true, actor: 'anonymous-readonly' } : { ok: false }; } const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || ''); return match && tokenMatches(apiToken, match[1]) ? { ok: true, actor: request.headers['x-actor-id'] || 'api' } : { ok: false }; }
function routeError(error) { if (error?.code === 'NOT_FOUND') return { statusCode: 404, code: 'NOT_FOUND', message: error.message }; if (['REVISION_CONFLICT', 'CONFLICT', 'STATE_CONFLICT', 'QA_BLOCKED'].includes(error?.code)) return { statusCode: 409, code: error.code, message: error.message }; if (['INVALID_PROVENANCE', 'INVALID_DEPENDENCY', 'INVALID_COST_OWNERSHIP'].includes(error?.code)) return { statusCode: 422, code: error.code, message: error.message }; if (error instanceof TypeError) return { statusCode: 400, code: 'VALIDATION_ERROR', message: error.message }; if (/Unknown episode|Unknown artifact|Unknown provider run|Unknown version/.test(error.message)) return { statusCode: 404, code: 'NOT_FOUND', message: error.message }; if (/revision conflict/.test(error.message)) return { statusCode: 409, code: 'REVISION_CONFLICT', message: error.message }; if (/already exists|Illegal episode transition|Illegal provider-run transition|Terminal provider runs|Only the current|not awaiting approval|provenance mismatch|no passing QA|not publishing|no approved render/.test(error.message)) return { statusCode: 409, code: 'STATE_CONFLICT', message: error.message }; return { statusCode: 400, code: 'INVALID_REQUEST', message: error.message }; }
function createApiServer({ service = new ProductionService(), repository = null, apiToken = process.env.API_BEARER_TOKEN || null, allowUnauthenticatedRead = process.env.ALLOW_UNAUTHENTICATED_READS === 'true', logger = console } = {}) {
  const server = http.createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] || randomUUID(); response.setHeader('x-request-id', requestId); const url = new URL(request.url || '/', 'http://localhost'); const path = url.pathname.split('/').filter(Boolean); const auth = authorize(request, { apiToken, allowUnauthenticatedRead }); if (!auth.ok) return send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' }, requestId });
    if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { status: 'ok', service: 'forge-studio-core' });
    if (request.method === 'GET' && url.pathname === '/readyz') {
      let persistence = repository ? 'configured' : 'in-memory'; let reconciliation = { status: 'unknown' };
      if (repository) {
        try { await repository.db.pool.query('SELECT 1'); } catch { persistence = 'unavailable'; }
        if (persistence === 'configured') {
          try { const r = await repository.db.pool.query("SELECT status,finished_at,scanned_count,repaired_count FROM forge_reconciliation_runs ORDER BY started_at DESC LIMIT 1"); const row = r.rows[0]; reconciliation = row ? { status: row.status, finishedAt: row.finished_at, scanned: row.scanned_count, repaired: row.repaired_count } : { status: 'never-run' }; } catch { reconciliation = { status: 'unavailable' }; }
        }
      }
      const ready = persistence !== 'unavailable'; return send(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not-ready', checks: { persistence, reconciliation } });
    }
    if (request.method === 'GET' && url.pathname === '/openapi.json') return send(response, 200, { openapi: '3.0.0', info: { title: 'Forge Studio API', version: '0.6.1' }, paths: {} });
    try {
      if (repository) {
        const persistent = await handlePersistent({ request, url, path, requestId, repository, actor: auth.actor }); if (persistent.handled) return send(response, persistent.statusCode, persistent.body);
      } else {
        if (request.method === 'GET' && url.pathname === '/v1/episodes') return send(response, 200, { items: service.episodes.list({ projectId: url.searchParams.get('projectId') || undefined }) });
        if (request.method === 'POST' && url.pathname === '/v1/episodes') { const body = await readJson(request); return send(response, 201, { item: service.episodes.create({ ...body, createdBy: auth.actor }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path.length === 3 && request.method === 'GET') { const item = service.getEpisodeSummary(decodeURIComponent(path[2])); return item ? send(response, 200, { item }) : send(response, 404, { error: { code: 'NOT_FOUND', message: 'Episode not found' }, requestId }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'transitions' && request.method === 'POST') { const body = await readJson(request); return send(response, 200, { item: service.episodes.transition(decodeURIComponent(path[2]), body.state, { actor: auth.actor, reason: body.reason || null, expectedRevision: body.expectedRevision }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'artifacts' && request.method === 'POST') { const body = await readJson(request); return send(response, 201, { item: service.artifacts.register({ ...body, episodeId: decodeURIComponent(path[2]), createdBy: auth.actor }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && path[4] && path[5] === 'transitions' && request.method === 'POST') { const body = await readJson(request); return send(response, 200, { item: service.providerRuns.transition(decodeURIComponent(path[4]), body.status, body.patch || {}) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && request.method === 'POST') { const body = await readJson(request); return send(response, 201, { item: service.providerRuns.start({ ...body, episodeId: decodeURIComponent(path[2]) }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'POST') { const body = await readJson(request); return send(response, 201, { item: service.providerRuns.recordCost({ ...body, episodeId: decodeURIComponent(path[2]) }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'GET') return send(response, 200, { item: service.providerRuns.episodeCost(decodeURIComponent(path[2])) });
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'qa' && request.method === 'POST') { const body = await readJson(request); return send(response, 201, { item: service.qa.record({ ...body, episodeId: decodeURIComponent(path[2]) }) }); }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'approvals' && request.method === 'POST') { const body = await readJson(request); if (body.stage === 'FINAL_RENDER' && body.decision === 'APPROVED') return send(response, 201, { item: service.approveFinalRender({ approvalId: body.id, episodeId: decodeURIComponent(path[2]), renderArtifactId: body.targetId, renderVersionId: body.targetVersionId, actor: auth.actor, comments: body.comments || '', evidence: body.evidence || {} }) }); return send(response, 201, { item: service.approvals.decide({ ...body, episodeId: decodeURIComponent(path[2]), actor: auth.actor }) }); }
      }
      return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId });
    } catch (error) { const mapped = routeError(error); logger.error?.('Forge API request failed', { requestId, error }); return send(response, mapped.statusCode, { error: { code: mapped.code, message: mapped.message }, requestId }); }
  });
  return { server, service };
}
async function handlePersistent() { return { handled: false }; }
function openApiDocument() { return { openapi: '3.0.0', info: { title: 'Forge Studio API', version: '0.6.1' }, paths: {} }; }
module.exports = { createApiServer, readJson, authorize, tokenMatches, routeError, openApiDocument };
