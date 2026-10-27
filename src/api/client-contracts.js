const { createHash, randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const http = require('node:http');
const { openApiDocument } = require('../http-api');
const { apiVersionContract } = require('./api-versioning');

const INSTALLED = Symbol.for('forge.clientContracts');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const SUPPORTED_ARTIFACTS = Object.freeze(['openapi-json', 'json-schema-bundle']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex'); }

function routeIdentity(method, pathname) { return `${method.toUpperCase()} ${pathname}`; }

function inferTenantRequirement(pathname, operation) {
  if (pathname === '/healthz' || pathname === '/readyz' || pathname === '/openapi.json') return false;
  if (operation?.x-tenantRequired !== undefined) return Boolean(operation['x-tenantRequired']);
  return true;
}

function inferAuthScope(operation, pathDocument) {
  const security = operation?.security ?? pathDocument?.security;
  if (security === []) return 'public';
  if (Array.isArray(security) && security.length) return Object.keys(security[0]).sort().join(',') || 'bearer';
  return 'bearer';
}

function operationSchema(operation, key) {
  const body = operation?.[key];
  if (!body) return null;
  if (body.content?.['application/json']?.schema) return body.content['application/json'].schema;
  return body.schema || null;
}

function responseSchemas(operation) {
  const result = {};
  for (const [status, response] of Object.entries(operation?.responses || {}).sort(([a], [b]) => a.localeCompare(b))) {
    result[status] = response?.content?.['application/json']?.schema || response?.schema || null;
  }
  return result;
}

function normalizeDocument(document, apiVersion) {
  const versionPrefix = new RegExp(`^/v${apiVersion}(?=/|$)`);
  const paths = {};
  for (const pathname of Object.keys(document.paths || {}).sort()) {
    const normalizedPath = pathname.replace(versionPrefix, `/v${apiVersion}`);
    const methods = {};
    for (const method of Object.keys(document.paths[pathname] || {}).filter((name) => METHODS.has(name)).sort()) {
      methods[method] = canonicalize(document.paths[pathname][method]);
    }
    if (Object.keys(methods).length) paths[normalizedPath] = methods;
  }
  return canonicalize({
    openapi: document.openapi || '3.0.3',
    info: { ...document.info, version: document.info?.version || `api-${apiVersion}` },
    servers: document.servers || [{ url: '/' }],
    security: document.security || [{ bearerAuth: [] }],
    paths,
    components: document.components || {},
  });
}

function generateContract({ document = openApiDocument(), apiVersion = '2' } = {}) {
  const normalized = normalizeDocument(document, apiVersion);
  const versionPolicy = apiVersionContract();
  const routes = [];
  for (const pathname of Object.keys(normalized.paths || {}).sort()) {
    const pathDocument = normalized.paths[pathname];
    for (const method of Object.keys(pathDocument).sort()) {
      if (!METHODS.has(method)) continue;
      const operation = pathDocument[method];
      const identity = routeIdentity(method, pathname);
      const responses = responseSchemas(operation);
      const route = {
        routeIdentity: identity,
        method: method.toUpperCase(),
        pathPattern: pathname,
        authScope: inferAuthScope(operation, normalized),
        tenantRequired: inferTenantRequirement(pathname, operation),
        deprecated: Boolean(operation.deprecated),
        sunsetAt: operation['x-sunsetAt'] || (apiVersion === '1' ? versionPolicy.sunset.date : null),
        requestSchema: operationSchema(operation, 'requestBody'),
        responseSchema: responses,
        examples: canonicalize({ request: operation.requestBody?.content?.['application/json']?.examples || {}, responses: Object.fromEntries(Object.entries(operation.responses || {}).filter(([, r]) => r?.content?.['application/json']?.examples).map(([s, r]) => [s, r.content['application/json'].examples])) }),
        metadata: canonicalize({ operationId: operation.operationId || null, tags: operation.tags || [], summary: operation.summary || null }),
      };
      route.routeFingerprint = sha256(route);
      routes.push(route);
    }
  }
  const compatibility = canonicalize({ apiVersion: `v${apiVersion}`, routes: routes.map((route) => ({ routeIdentity: route.routeIdentity, method: route.method, pathPattern: route.pathPattern, authScope: route.authScope, tenantRequired: route.tenantRequired, deprecated: route.deprecated, sunsetAt: route.sunsetAt, requestSchema: route.requestSchema, responseSchema: route.responseSchema })) });
  const contract = canonicalize({ contractFormatVersion: 1, generatedFrom: 'runtime-openapiDocument', apiVersion: `v${apiVersion}`, policy: versionPolicy, document: normalized, routes, compatibilityFingerprint: sha256(compatibility) });
  return { contract, contractFingerprint: sha256(contract), compatibilityFingerprint: contract.compatibilityFingerprint, routes };
}

function compareContracts(previous, current) {
  if (!previous) return { breaking: false, changes: [], reason: 'no-previous-contract' };
  const oldRoutes = new Map((previous.routes || []).map((r) => [r.routeIdentity, r]));
  const newRoutes = new Map((current.routes || []).map((r) => [r.routeIdentity, r]));
  const changes = [];
  for (const [identity, oldRoute] of oldRoutes) {
    const next = newRoutes.get(identity);
    if (!next) changes.push({ type: 'removed-route', routeIdentity: identity, breaking: true });
    else {
      if (sha256(oldRoute.requestSchema) !== sha256(next.requestSchema)) changes.push({ type: 'request-schema-changed', routeIdentity: identity, breaking: true });
      if (sha256(oldRoute.responseSchema) !== sha256(next.responseSchema)) changes.push({ type: 'response-schema-changed', routeIdentity: identity, breaking: true });
      if (oldRoute.authScope !== next.authScope || oldRoute.tenantRequired !== next.tenantRequired) changes.push({ type: 'security-contract-changed', routeIdentity: identity, breaking: true });
      if (!oldRoute.deprecated && next.deprecated) changes.push({ type: 'deprecated', routeIdentity: identity, breaking: false });
      if (oldRoute.sunsetAt !== next.sunsetAt) changes.push({ type: 'sunset-changed', routeIdentity: identity, breaking: false });
    }
  }
  for (const [identity] of newRoutes) if (!oldRoutes.has(identity)) changes.push({ type: 'added-route', routeIdentity: identity, breaking: false });
  return { breaking: changes.some((change) => change.breaking), changes };
}

function json(response, status, body, headers = {}) {
  if (response.headersSent) return false;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
  return true;
}

function operatorAuth(request) {
  try {
    const { authenticate, hasRole } = require('../security/http-security');
    const auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
    return auth && hasRole(auth, 'OWNER') ? auth : null;
  } catch { return null; }
}

function createStore(pool) {
  async function ensure() { return Boolean(pool); }
  async function latest(apiVersion) {
    if (!pool) return null;
    const result = await pool.query("SELECT * FROM forge_client_contract_revisions WHERE api_version=$1 AND status IN ('PUBLISHED','SUPERSEDED','ROLLED_BACK') ORDER BY generated_at DESC LIMIT 1", [apiVersion]);
    return result.rows[0] || null;
  }
  async function loadRoutes(revisionId) { const result = await pool.query('SELECT * FROM forge_client_contract_routes WHERE revision_id=$1 ORDER BY route_identity', [revisionId]); return result.rows; }
  async function publish({ generated, apiVersion, actor, tenantId, sourceCommit, decisionId = null }) {
    const client = await pool.connect();
    const revisionId = `contract:${apiVersion}:${generated.contractFingerprint.slice(0, 16)}`;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forge-client-contract:${apiVersion}`]);
      const previous = await client.query("SELECT * FROM forge_client_contract_revisions WHERE api_version=$1 AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1 FOR UPDATE", [apiVersion]);
      const previousRoutes = previous.rows[0] ? await client.query('SELECT * FROM forge_client_contract_routes WHERE revision_id=$1', [previous.rows[0].id]) : { rows: [] };
      const previousContract = previous.rows[0] ? { routes: previousRoutes.rows.map((row) => ({ routeIdentity: row.route_identity, method: row.method, pathPattern: row.path_pattern, authScope: row.auth_scope, tenantRequired: row.tenant_required, deprecated: row.deprecated, sunsetAt: row.sunset_at, requestSchema: row.request_schema, responseSchema: row.response_schema })) } : null;
      const compatibility = compareContracts(previousContract, generated);
      if (compatibility.breaking && !decisionId) { await client.query('ROLLBACK'); const error = Object.assign(new Error('Breaking API contract requires an explicit compatibility decision'), { statusCode: 409, code: 'BREAKING_CONTRACT_REQUIRES_APPROVAL', compatibility }); throw error; }
      if (decisionId) {
        const decision = await client.query("SELECT id,decision FROM forge_client_contract_compatibility_decisions WHERE id=$1 AND to_contract_fingerprint=$2 AND decision='APPROVED_BREAKING'", [decisionId, generated.contractFingerprint]);
        if (!decision.rows[0] && compatibility.breaking) { await client.query('ROLLBACK'); throw Object.assign(new Error('Compatibility decision is missing, rejected, or targets a different contract'), { statusCode: 409, code: 'INVALID_COMPATIBILITY_DECISION' }); }
      }
      const revision = await client.query(`INSERT INTO forge_client_contract_revisions(id,contract_version,api_version,status,source_commit,route_count,contract_fingerprint,compatibility_fingerprint,previous_revision_id,compatibility_decision_id,metadata) VALUES($1,$2,$3,'PUBLISHED',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING *`, [revisionId, `v${apiVersion}-${generated.contractFingerprint.slice(0,12)}`, `v${apiVersion}`, sourceCommit || null, generated.routes.length, generated.contractFingerprint, generated.compatibilityFingerprint, previous.rows[0]?.id || null, decisionId, JSON.stringify({generator: 'runtime-openapiDocument', artifacts: SUPPORTED_ARTIFACTS})]);
      if (previous.rows[0]) await client.query("UPDATE forge_client_contract_revisions SET status='SUPERSEDED' WHERE id=$1", [previous.rows[0].id]);
      for (const route of generated.routes) await client.query(`INSERT INTO forge_client_contract_routes(revision_id,route_identity,method,path_pattern,auth_scope,tenant_required,deprecated,sunset_at,route_fingerprint,request_schema,response_schema,examples,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb) ON CONFLICT(revision_id,route_identity) DO UPDATE SET route_fingerprint=EXCLUDED.route_fingerprint`, [revisionId, route.routeIdentity, route.method, route.pathPattern, route.authScope, route.tenantRequired, route.deprecated, route.sunsetAt, route.routeFingerprint, JSON.stringify(route.requestSchema), JSON.stringify(route.responseSchema), JSON.stringify(route.examples), JSON.stringify(route.metadata)]);
      const openapiContent = stableJson(generated.contract.document);
      const schemaContent = stableJson({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: `Forge Studio API v${apiVersion} contract`, type: 'object', properties: Object.fromEntries(generated.routes.map((route) => [route.routeIdentity, { type: 'object', properties: { request: route.requestSchema || {}, response: route.responseSchema || {} } }])) });
      for (const [kind, filename, mediaType, content] of [['openapi-json', `forge-api-v${apiVersion}.openapi.json`, 'application/json', openapiContent], ['json-schema-bundle', `forge-api-v${apiVersion}.schema.json`, 'application/schema+json', schemaContent]]) await client.query(`INSERT INTO forge_client_contract_artifacts(id,revision_id,artifact_kind,filename,media_type,content,checksum) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(revision_id,artifact_kind) DO UPDATE SET content=EXCLUDED.content,checksum=EXCLUDED.checksum`, [`artifact:${revisionId}:${kind}`, revisionId, kind, filename, mediaType, content, sha256(content)]);
      await client.query('INSERT INTO forge_client_contract_audit(revision_id,action,actor_id,tenant_id,details) VALUES($1,$2,$3,$4,$5::jsonb)', [revisionId, 'PUBLISHED', actor || 'system', tenantId || null, JSON.stringify({ compatibility, decisionId })]);
      await client.query('COMMIT');
      return { revision: revision.rows[0], compatibility };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  return { ensure, latest, loadRoutes, publish };
}

async function handle(request, response, store) {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (!pathname.startsWith('/v1/client-contract') && !pathname.startsWith('/internal/client-contracts')) return false;
  if (!store?.pool) return json(response, 503, { error: { code: 'PERSISTENCE_UNAVAILABLE' } });
  if (pathname.startsWith('/internal/client-contracts')) {
    const auth = operatorAuth(request);
    if (!auth) return json(response, 403, { error: { code: 'FORBIDDEN', message: 'Operator role required' } });
    if (request.method === 'GET' && pathname === '/internal/client-contracts') return json(response, 200, { items: (await store.pool.query('SELECT * FROM forge_client_contract_revisions ORDER BY generated_at DESC LIMIT 500')).rows });
    if (request.method === 'GET' && pathname === '/internal/client-contracts/consumers') return json(response, 200, { items: (await store.pool.query('SELECT * FROM forge_client_contract_consumers ORDER BY last_seen_at DESC LIMIT 500')).rows });
    if (request.method === 'GET' && pathname === '/internal/client-contracts/audit') return json(response, 200, { items: (await store.pool.query('SELECT * FROM forge_client_contract_audit ORDER BY created_at DESC LIMIT 500')).rows });
    if (request.method === 'POST' && pathname === '/internal/client-contracts/compatibility-decisions') {
      let raw=''; for await (const chunk of request) raw += chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(response,400,{error:{code:'MALFORMED_JSON'}}); }
      if (!body.toContractFingerprint || !['APPROVED_BREAKING','APPROVED_NON_BREAKING','REJECTED'].includes(body.decision) || !body.rationale) return json(response,400,{error:{code:'INVALID_COMPATIBILITY_DECISION'}});
      const id=`decision:${randomUUID()}`; const result=await store.pool.query('INSERT INTO forge_client_contract_compatibility_decisions(id,from_revision_id,to_contract_fingerprint,decision,rationale,actor_id,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,body.fromRevisionId||null,body.toContractFingerprint,body.decision,body.rationale,auth.actor,auth.tenantId||null]); return json(response,201,{item:result.rows[0]});
    }
    if (request.method === 'POST' && pathname === '/internal/client-contracts/publish') {
      let raw=''; for await (const chunk of request) raw += chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(response,400,{error:{code:'MALFORMED_JSON'}}); }
      const generated=generateContract({apiVersion:body.apiVersion||'2'}); const result=await store.publish({generated,apiVersion:body.apiVersion||'2',actor:auth.actor,tenantId:auth.tenantId,sourceCommit:body.sourceCommit,decisionId:body.decisionId||null}); return json(response,201,{item:result});
    }
    if (request.method === 'GET' && pathname.startsWith('/internal/client-contracts/artifacts/')) {
      const parts=pathname.split('/').filter(Boolean); const revisionId=decodeURIComponent(parts[3]||''); const kind=parts[4] || 'openapi-json'; const result=await store.pool.query('SELECT filename,media_type,content,checksum FROM forge_client_contract_artifacts WHERE revision_id=$1 AND artifact_kind=$2',[revisionId,kind]); if(!result.rows[0])return json(response,404,{error:{code:'ARTIFACT_NOT_FOUND'}}); const artifact=result.rows[0]; response.writeHead(200,{'content-type':artifact.media_type,'content-disposition':`attachment; filename="${artifact.filename}"`,'etag':`"${artifact.checksum}"`,'cache-control':'no-store'}); response.end(artifact.content); return true;
    }
    return json(response,404,{error:{code:'NOT_FOUND'}});
  }
  if (request.method === 'GET' && pathname === '/v1/client-contract/openapi.json') {
    const revision=await store.latest('v2'); if(!revision)return json(response,404,{error:{code:'CONTRACT_NOT_PUBLISHED'}}); const artifact=await store.pool.query("SELECT content,checksum FROM forge_client_contract_artifacts WHERE revision_id=$1 AND artifact_kind='openapi-json'",[revision.id]); if(!artifact.rows[0])return json(response,404,{error:{code:'ARTIFACT_NOT_FOUND'}}); return json(response,200,JSON.parse(artifact.rows[0].content),{'etag':`"${artifact.rows[0].checksum}"`});
  }
  if (request.method === 'GET' && pathname === '/v1/client-contract/history') return json(response,200,{items:(await store.pool.query("SELECT id,contract_version,api_version,status,contract_fingerprint,compatibility_fingerprint,generated_at,published_at,previous_revision_id FROM forge_client_contract_revisions ORDER BY generated_at DESC LIMIT 100")).rows});
  if (request.method === 'GET' && pathname === '/v1/client-contract') {
    const revision=await store.latest('v2'); if(!revision)return json(response,404,{error:{code:'CONTRACT_NOT_PUBLISHED'}}); return json(response,200,{item:revision});
  }
  return json(response,404,{error:{code:'NOT_FOUND'}});
}

function installClientContracts(options={}) {
  if (http[INSTALLED]) return http[INSTALLED];
  let pool=options.pool||null;
  if (!pool && process.env.DATABASE_URL) { try { const { Pool } = require('pg'); pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:30000,connectionTimeoutMillis:5000}); } catch {} }
  const store={pool,...createStore(pool)};
  const originalCreateServer=http.createServer;
  http.createServer=function patchedCreateServer(requestListener){ const server=originalCreateServer.call(this); const originalOn=server.on.bind(server); const originalAddListener=server.addListener.bind(server); const wrap=(listener)=>(request,response)=>handle(request,response,store).then((handled)=>handled?undefined:listener(request,response)); server.on=(event,listener)=>originalOn(event,event==='request'?wrap(listener):listener); server.addListener=(event,listener)=>originalAddListener(event,event==='request'?wrap(listener):listener); if(requestListener)server.on('request',requestListener); return server; };
  http[INSTALLED]={pool,store,generateContract,compareContracts};
  return http[INSTALLED];
}

module.exports={canonicalize,stableJson,sha256,generateContract,compareContracts,installClientContracts,handle};
