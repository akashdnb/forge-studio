const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { ProductionService } = require('./domain/production-service');
const { PersistentProductionRepository } = require('./persistence/production-repository');

const JSON_LIMIT_BYTES = 1024 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_ROUTES = new Set(['GET /healthz', 'GET /readyz', 'GET /openapi.json']);

function send(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error('Request body exceeds 1 MiB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
    return parsed;
  } catch (cause) {
    const error = new Error('Malformed JSON request body');
    error.statusCode = 400;
    error.cause = cause;
    throw error;
  }
}

function tokenMatches(expected, actual) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorize(request, { apiToken, allowUnauthenticatedRead = false }) {
  const method = request.method || 'GET';
  const url = new URL(request.url || '/', 'http://localhost');
  if (PUBLIC_ROUTES.has(`${method} ${url.pathname}`)) return { ok: true, actor: 'system-health' };
  // When configured, all API routes require a token (reads as well as writes).
  // In local development without a token, read-only routes can be allowed, but
  // mutating routes are blocked unless explicitly configured otherwise.
  if (!apiToken) {
    if (MUTATING_METHODS.has(method)) return { ok: false };
    return allowUnauthenticatedRead ? { ok: true, actor: 'anonymous-readonly' } : { ok: false };
  }
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match && tokenMatches(apiToken, match[1])
    ? { ok: true, actor: request.headers['x-actor-id'] || 'api' }
    : { ok: false };
}

function routeError(error) {
  if (error && error.code === 'NOT_FOUND') return { statusCode: 404, code: 'NOT_FOUND', message: error.message };
  if (error && (error.code === 'REVISION_CONFLICT' || error.code === 'CONFLICT' || error.code === 'STATE_CONFLICT')) {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error instanceof TypeError) return { statusCode: 400, code: 'VALIDATION_ERROR', message: error.message };
  if (/Unknown episode|Unknown artifact|Unknown provider run|Unknown version/.test(error.message)) {
    return { statusCode: 404, code: 'NOT_FOUND', message: error.message };
  }
  if (/revision conflict/.test(error.message)) return { statusCode: 409, code: 'REVISION_CONFLICT', message: error.message };
  if (/already exists|Illegal episode transition|Illegal provider-run transition|Terminal provider runs|Only the currently selected render|not awaiting approval|provenance mismatch|no passing or warning-only QA|not publishing|no approved render/.test(error.message)) {
    return { statusCode: 409, code: 'STATE_CONFLICT', message: error.message };
  }
  return { statusCode: 400, code: 'INVALID_REQUEST', message: error.message };
}

function createApiServer({
  service = new ProductionService(),
  repository = null,
  apiToken = process.env.API_BEARER_TOKEN || null,
  allowUnauthenticatedRead = process.env.ALLOW_UNAUTHENTICATED_READS === 'true',
  logger = console,
} = {}) {
  const server = http.createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] || randomUUID();
    response.setHeader('x-request-id', requestId);
    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean);
    const auth = authorize(request, { apiToken, allowUnauthenticatedRead });

    if (!auth.ok) return send(response, 401, {
      error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' }, requestId,
    });

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return send(response, 200, { status: 'ok', service: 'forge-studio-core' });
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      let persistence = repository ? 'configured' : 'in-memory';
      if (repository) {
        try { await repository.db.pool.query('SELECT 1'); } catch { persistence = 'unavailable'; }
      }
      return send(response, persistence === 'unavailable' ? 503 : 200, {
        status: persistence === 'unavailable' ? 'not-ready' : 'ready',
        checks: { persistence },
      });
    }
    if (request.method === 'GET' && url.pathname === '/openapi.json') return send(response, 200, openApiDocument());

    try {
      if (repository) {
        const persistentResponse = await handlePersistent({ request, response, url, path, requestId, repository, actor: auth.actor });
        if (persistentResponse.handled) return send(response, persistentResponse.statusCode, persistentResponse.body);
      } else {
        if (request.method === 'GET' && url.pathname === '/v1/episodes') {
          return send(response, 200, { items: service.episodes.list({ projectId: url.searchParams.get('projectId') || undefined }) });
        }
        if (request.method === 'POST' && url.pathname === '/v1/episodes') {
          const body = await readJson(request);
          const item = service.episodes.create({ ...body, createdBy: auth.actor });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && request.method === 'GET' && path.length === 3) {
          const summary = service.getEpisodeSummary(decodeURIComponent(path[2]));
          if (!summary) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Episode not found' }, requestId });
          return send(response, 200, { item: summary });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'transitions' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.episodes.transition(decodeURIComponent(path[2]), body.state, {
            actor: auth.actor, reason: body.reason || null, expectedRevision: body.expectedRevision,
          });
          return send(response, 200, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'artifacts' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.artifacts.register({ ...body, episodeId: decodeURIComponent(path[2]), createdBy: auth.actor });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && path[4] && path[5] === 'transitions' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 200, body: { item: await repository.transitionProviderRun({
      id: decodeURIComponent(path[4]), status: body.status, patch: body.patch || {},
    }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'qa' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.recordQa({ ...body, episodeId: decodeURIComponent(path[2]) }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'approvals' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.appendApproval({ ...body, episodeId: decodeURIComponent(path[2]), actor }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'render' && request.method === 'PUT') {
    const body = await readJson(request);
    return { handled: true, statusCode: 200, body: { item: await repository.selectRender({
      id: decodeURIComponent(path[2]), renderArtifactId: body.renderArtifactId, expectedRevision: body.expectedRevision,
    }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.providerRuns.start({ ...body, episodeId: decodeURIComponent(path[2]) });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && path[4] && path[5] === 'transitions' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.providerRuns.transition(decodeURIComponent(path[4]), body.status, body.patch || {});
          return send(response, 200, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.providerRuns.recordCost({ ...body, episodeId: decodeURIComponent(path[2]) });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'GET') {
          return send(response, 200, { item: service.providerRuns.episodeCost(decodeURIComponent(path[2])) });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'qa' && request.method === 'POST') {
          const body = await readJson(request);
          const item = service.qa.record({ ...body, episodeId: decodeURIComponent(path[2]) });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'approvals' && request.method === 'POST') {
          const body = await readJson(request);
          if (body.stage === 'FINAL_RENDER' && body.decision === 'APPROVED') {
            const result = service.approveFinalRender({
              approvalId: body.id, episodeId: decodeURIComponent(path[2]), renderArtifactId: body.targetId,
              renderVersionId: body.targetVersionId, actor: auth.actor, comments: body.comments || '',
            });
            return send(response, 201, { item: result });
          }
          const item = service.approvals.decide({ ...body, episodeId: decodeURIComponent(path[2]), actor: auth.actor });
          return send(response, 201, { item });
        }
        if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'render' && request.method === 'PUT') {
          const body = await readJson(request);
          const item = service.episodes.selectRender(decodeURIComponent(path[2]), body.renderArtifactId, { expectedRevision: body.expectedRevision });
          return send(response, 200, { item });
        }
        if (path[0] === 'v1' && path[1] === 'versions' && path[2] && path[3] === 'invalidation-plan' && request.method === 'POST') {
          const body = await readJson(request);
          const items = service.graph.invalidationPlan(body.changedVersionIds || []);
          return send(response, 200, { items });
        }
      }
      return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId });
    } catch (error) {
      const mapped = Number.isInteger(error.statusCode)
        ? { statusCode: error.statusCode, code: error.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: error.message }
        : routeError(error);
      if (mapped.statusCode >= 500) logger.error?.({ requestId, message: error.message });
      return send(response, mapped.statusCode, { error: { code: mapped.code, message: mapped.message }, requestId });
    }
  });
  return { server, service, repository };
}

async function handlePersistent({ request, url, path, requestId, repository, actor }) {
  if (request.method === 'GET' && url.pathname === '/v1/episodes') {
    const items = await repository.listEpisodes({
      projectId: url.searchParams.get('projectId') || undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
      offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0,
    });
    return { handled: true, statusCode: 200, body: { items } };
  }
  if (request.method === 'POST' && url.pathname === '/v1/episodes') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.createEpisode({ ...body, createdBy: actor }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path.length === 3 && request.method === 'GET') {
    const item = await repository.getEpisode(decodeURIComponent(path[2]));
    return item
      ? { handled: true, statusCode: 200, body: { item } }
      : { handled: true, statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'Episode not found' }, requestId } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'transitions' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 200, body: { item: await repository.transitionEpisode({
      id: decodeURIComponent(path[2]), nextState: body.state, actor, reason: body.reason || null, expectedRevision: body.expectedRevision,
    }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'artifacts' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.registerArtifact({ ...body, episodeId: decodeURIComponent(path[2]), createdBy: actor }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.createProviderRun({ ...body, episodeId: decodeURIComponent(path[2]) }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'POST') {
    const body = await readJson(request);
    return { handled: true, statusCode: 201, body: { item: await repository.recordCost({ ...body, episodeId: decodeURIComponent(path[2]) }) } };
  }
  if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs' && request.method === 'GET') {
    return { handled: true, statusCode: 200, body: { item: await repository.episodeCost(decodeURIComponent(path[2])) } };
  }
  if (path[0] === 'v1' && path[1] === 'versions' && path[2] && path[3] === 'invalidation-plan' && request.method === 'POST') {
    return { handled: true, statusCode: 200, body: { items: await repository.invalidationPlan(decodeURIComponent(path[2])) } };
  }
  return { handled: false };
}

function openApiDocument() {
  return {
    openapi: '3.0.3',
    info: { title: 'Forge Studio API', version: '0.3.0', description: 'Episode production API. Requires a bearer token when API_BEARER_TOKEN is configured.' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque token' } } },
    security: [{ bearerAuth: [] }],
    paths: {
      '/healthz': { get: { summary: 'Liveness check', security: [], responses: { 200: { description: 'Process is alive' } } } },
      '/readyz': { get: { summary: 'Readiness check', security: [], responses: { 200: { description: 'Dependencies ready' } } } },
      '/v1/episodes': {
        get: { summary: 'List episodes', responses: { 200: { description: 'Episode collection' }, 401: { description: 'Unauthorized' } } },
        post: { summary: 'Create episode', responses: { 201: { description: 'Episode created' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthorized' } } },
      },
      '/v1/episodes/{episodeId}': {
        get: { summary: 'Get episode', parameters: [{ name: 'episodeId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Episode' }, 404: { description: 'Episode not found' } } },
      },
      '/v1/episodes/{episodeId}/transitions': { post: { summary: 'Transition episode state', responses: { 200: { description: 'State updated' }, 409: { description: 'Invalid transition or revision conflict' } } } },
      '/v1/episodes/{episodeId}/artifacts': { post: { summary: 'Register artifact', responses: { 201: { description: 'Artifact registered' } } } },
      '/v1/episodes/{episodeId}/provider-runs': { post: { summary: 'Start logical provider run', responses: { 201: { description: 'Provider run recorded' } } } },
      '/v1/episodes/{episodeId}/costs': {
        get: { summary: 'Get aggregated episode cost by currency', responses: { 200: { description: 'Cost summary' } } },
        post: { summary: 'Record provider cost event', responses: { 201: { description: 'Cost event recorded' } } },
      },
      '/v1/episodes/{episodeId}/qa': { post: { summary: 'Record QA result', responses: { 201: { description: 'QA result recorded' } } } },
      '/v1/episodes/{episodeId}/approvals': { post: { summary: 'Record approval decision', responses: { 201: { description: 'Decision recorded' }, 409: { description: 'Approval blocked' } } } },
      '/v1/episodes/{episodeId}/render': { put: { summary: 'Select current render', responses: { 200: { description: 'Render selected' } } } },
      '/v1/versions/{versionId}/invalidation-plan': { post: { summary: 'Plan downstream regeneration', responses: { 200: { description: 'Invalidation plan' } } } },
    },
  };
}

module.exports = { createApiServer, openApiDocument, readJson, authorize, tokenMatches };
