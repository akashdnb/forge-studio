const http = require('node:http');
const { PostgresRepository } = require('./postgres-repository');
const { PersistentProductionRepository } = require('./production-repository');
const { AsyncEpisodeOrchestrator } = require('../pipeline/async-orchestrator');
const { requiredString } = require('../domain/records');
const { runIdempotencyContext, getIdempotencyContext, withIdempotencyTransaction } = require('./api-idempotency');

function operationForRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname.split('/').filter(Boolean);
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'publish') return 'episode.publish';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'workflow') return 'episode.workflow.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'approvals') return 'episode.approval';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'artifacts') return 'episode.artifact.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'provider-runs') return 'episode.provider-run.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'costs') return 'episode.cost.record';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'qa') return 'episode.qa.record';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'transitions') return 'episode.transition';
  if (method === 'PUT' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'render') return 'episode.render.select';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'research') return 'episode.research.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'timeline') return 'episode.timeline.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path[2] && path[3] === 'shorts' && path[4] === 'handoff') return 'episode.shorts.handoff';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'episodes' && path.length === 2) return 'episode.create';
  if (method === 'POST' && path[0] === 'v1' && path[1] === 'projects' && path.length === 2) return 'project.create';
  return `${method.toLowerCase()}:${url.pathname}`;
}

function resourceIdForRequest(req) {
  const path = new URL(req.url || '/', 'http://localhost').pathname.split('/').filter(Boolean);
  if (path[0] !== 'v1') return null;
  if (path[1] === 'episodes' && path[2]) return decodeURIComponent(path[2]);
  if (path[1] === 'versions' && path[2]) return decodeURIComponent(path[2]);
  return null;
}

function responseStatusForOperation(operation, method) {
  if (operation === 'episode.workflow.create' || operation === 'episode.publish') return 202;
  if (method === 'POST') return 201;
  return 200;
}

function installPostgresBoundary() {
  const original = PostgresRepository.prototype.withTransaction;
  if (original.__forgeIdempotencyBoundary) return;
  async function withIdempotencyBoundary(operation) {
    const context = getIdempotencyContext();
    if (!context) return original.call(this, operation);
    let effectiveContext = context;
    try {
      const { getEvidenceContext } = require('../evidence/audit-evidence');
      const evidence = getEvidenceContext();
      if (evidence?.tenantId) effectiveContext = { ...context, tenantId: evidence.tenantId, actor: evidence.actor || context.actor, requestId: evidence.requestId || context.requestId };
    } catch { /* evidence context is optional for unit/in-process callers */ }
    return withIdempotencyTransaction(this.pool, effectiveContext, async (client, idempotencyContext) => {
      try {
        const { getEvidenceContext } = require('../evidence/audit-evidence');
        const evidence = getEvidenceContext();
        await client.query("SELECT set_config('forge.actor',$1,true), set_config('forge.tenant_id',$2,true), set_config('forge.request_id',$3,true), set_config('forge.causal_event_id',$4,true)",
          [evidence.actor, evidence.tenantId, evidence.requestId, evidence.causalEventId]);
      } catch { /* evidence context is optional for unit/in-process callers */ }
      return operation(client, idempotencyContext);
    }, { responseStatus: responseStatusForOperation(context.operation, context.method) });
  }
  withIdempotencyBoundary.__forgeIdempotencyBoundary = true;
  PostgresRepository.prototype.withTransaction = withIdempotencyBoundary;
}

function installProjectCreationBoundary() {
  const original = PersistentProductionRepository.prototype.createProject;
  if (original.__forgeIdempotencyBoundary) return;
  async function createProjectWithIdempotency(input) {
    const context = getIdempotencyContext();
    if (!context) return original.call(this, input);
    const normalized = { ...input, id: requiredString(input.id, 'id'), name: requiredString(input.name, 'name') };
    return withIdempotencyTransaction(this.db.pool, context, async (client) => {
      const project = (await client.query('INSERT INTO projects(id,name,created_by,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING *',
        [normalized.id, normalized.name, normalized.createdBy || 'system', JSON.stringify(normalized.metadata || {})])).rows[0];
      await client.query("INSERT INTO project_members(project_id,actor_id,role) VALUES($1,$2,'OWNER') ON CONFLICT DO NOTHING", [project.id, normalized.createdBy || 'system']);
      return project;
    }, { responseStatus: 201 });
  }
  createProjectWithIdempotency.__forgeIdempotencyBoundary = true;
  PersistentProductionRepository.prototype.createProject = createProjectWithIdempotency;
}

function installWorkflowKeyBridge() {
  const original = AsyncEpisodeOrchestrator.prototype.enqueue;
  if (original.__forgeIdempotencyKeyBridge) return;
  async function enqueueWithRequestKey(args) {
    const context = getIdempotencyContext();
    if (!context || args?.idempotencyPrefix) return original.call(this, args);
    return original.call(this, { ...args, idempotencyPrefix: context.idempotencyKey });
  }
  enqueueWithRequestKey.__forgeIdempotencyKeyBridge = true;
  AsyncEpisodeOrchestrator.prototype.enqueue = enqueueWithRequestKey;
}

function installHttpContext() {
  const originalEmit = http.Server.prototype.emit;
  if (originalEmit.__forgeIdempotencyHttpContext) return;
  function emit(event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args);
    const req = args[0];
    const key = req.headers['idempotency-key'];
    if (!key) return originalEmit.call(this, event, ...args);
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const projectId = req.headers['x-project-id'] || null;
    const tenantId = req.headers['x-tenant-id'] || null;
    const requestHash = req.headers['x-forge-request-hash'] || null;
    if (!requestHash || !/^[a-f0-9]{64}$/i.test(String(requestHash))) {
      const response = args[1];
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'REQUEST_FINGERPRINT_REQUIRED', message: 'Idempotent requests require X-Forge-Request-Hash (SHA-256 of the canonical request)' } }));
      return true;
    }
    const operation = operationForRequest(req);
    const resourceId = resourceIdForRequest(req);
    const context = {
      idempotencyKey: String(key),
      operation,
      tenantId: tenantId ? String(tenantId) : null,
      projectId: projectId ? String(projectId) : null,
      requestHash: String(requestHash).toLowerCase(),
      actor: String(req.headers['x-actor-id'] || 'api'),
      requestId: String(req.headers['x-request-id'] || 'unknown'),
      resourceId,
      resourceType: resourceId ? (url.pathname.includes('/episodes/') ? 'episode' : 'resource') : null,
      method,
    };
    if (!context.tenantId && !context.projectId) {
      const response = args[1];
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_SCOPE_REQUIRED', message: 'Idempotent requests require X-Tenant-Id or X-Project-Id' } }));
      return true;
    }
    return runIdempotencyContext(context, () => originalEmit.call(this, event, ...args));
  }
  emit.__forgeIdempotencyHttpContext = true;
  http.Server.prototype.emit = emit;
}

installPostgresBoundary();
installProjectCreationBoundary();
installWorkflowKeyBridge();
installHttpContext();

module.exports = { operationForRequest, resourceIdForRequest, responseStatusForOperation };
