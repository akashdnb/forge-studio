const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { ProductionService } = require('./domain/production-service');

const JSON_LIMIT_BYTES = 1024 * 1024;

function send(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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

function routeError(error) {
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

function createApiServer({ service = new ProductionService(), logger = console } = {}) {
  const server = http.createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] || randomUUID();
    response.setHeader('x-request-id', requestId);
    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return send(response, 200, { status: 'ok', service: 'forge-studio-core' });
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      return send(response, 200, { status: 'ready', checks: { domainServices: 'ok', persistence: 'in-memory' } });
    }
    if (request.method === 'GET' && url.pathname === '/v1/episodes') {
      return send(response, 200, { items: service.episodes.list({ projectId: url.searchParams.get('projectId') || undefined }) });
    }

    try {
      if (request.method === 'POST' && url.pathname === '/v1/episodes') {
        const body = await readJson(request);
        const created = service.episodes.create(body);
        return send(response, 201, { item: created });
      }
      if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && request.method === 'GET' && path.length === 3) {
        const summary = service.getEpisodeSummary(decodeURIComponent(path[2]));
        if (!summary) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Episode not found' }, requestId });
        return send(response, 200, { item: summary });
      }
      if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'transitions' && request.method === 'POST') {
        const body = await readJson(request);
        const item = service.episodes.transition(decodeURIComponent(path[2]), body.state, {
          actor: body.actor || 'api', reason: body.reason || null,
          expectedRevision: body.expectedRevision,
        });
        return send(response, 200, { item });
      }
      if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'artifacts' && request.method === 'POST') {
        const body = await readJson(request);
        const item = service.artifacts.register({ ...body, episodeId: decodeURIComponent(path[2]) });
        return send(response, 201, { item });
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
            approvalId: body.id, episodeId: decodeURIComponent(path[2]),
            renderArtifactId: body.targetId, renderVersionId: body.targetVersionId,
            actor: body.actor, comments: body.comments || '',
          });
          return send(response, 201, { item: result });
        }
        const item = service.approvals.decide({ ...body, episodeId: decodeURIComponent(path[2]) });
        return send(response, 201, { item });
      }
      if (path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'render' && request.method === 'PUT') {
        const body = await readJson(request);
        const item = service.episodes.selectRender(decodeURIComponent(path[2]), body.renderArtifactId, {
          expectedRevision: body.expectedRevision,
        });
        return send(response, 200, { item });
      }
      if (path[0] === 'v1' && path[1] === 'versions' && path[2] && path[3] === 'invalidation-plan' && request.method === 'POST') {
        const body = await readJson(request);
        const item = service.graph.invalidationPlan(body.changedVersionIds || []);
        return send(response, 200, { items: item });
      }
      if (request.method === 'GET' && url.pathname === '/openapi.json') {
        return send(response, 200, openApiDocument());
      }
      return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId });
    } catch (error) {
      const mapped = Number.isInteger(error.statusCode)
        ? { statusCode: error.statusCode, code: 'BAD_REQUEST', message: error.message }
        : routeError(error);
      if (mapped.statusCode >= 500) {
        logger.error?.({ requestId, message: error.message });
      }
      return send(response, mapped.statusCode, {
        error: { code: mapped.code, message: mapped.message }, requestId,
      });
    }
  });
  return { server, service };
}

function openApiDocument() {
  return {
    openapi: '3.0.3',
    info: { title: 'Forge Studio API', version: '0.1.0', description: 'Episode production domain API. Persistence is currently in-memory.' },
    paths: {
      '/healthz': { get: { summary: 'Liveness check', responses: { 200: { description: 'Process is alive' } } } },
      '/readyz': { get: { summary: 'Readiness check', responses: { 200: { description: 'Process is ready' } } } },
      '/v1/episodes': {
        get: { summary: 'List episodes', responses: { 200: { description: 'Episode collection' } } },
        post: { summary: 'Create episode', responses: { 201: { description: 'Episode created' }, 400: { description: 'Validation error' } } },
      },
      '/v1/episodes/{episodeId}': {
        get: { summary: 'Get episode production summary', parameters: [{ name: 'episodeId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Episode summary' }, 404: { description: 'Episode not found' } } },
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

module.exports = { createApiServer, openApiDocument };
