const { createHash } = require('node:crypto');
const { URL } = require('node:url');
const http = require('node:http');

const INSTALLED = Symbol.for('forge.apiContractGovernance');
const SUPPORTED = new Set(['v1', 'v2']);
const DEFAULT_SUNSET = process.env.FORGE_API_V1_SUNSET || '2027-04-27T00:00:00Z';
const OPERATOR_PREFIX = '/internal/api-contracts';
const RESOURCES = new Set(['episodes','projects','jobs','versions','artifacts','providers','usage','bundles','reviews','evidence','research','timeline','approvals','qa','render','publish','shorts','transitions','workflow','costs']);

function fingerprint(value) {
  const normalize = (input) => {
    if (input === null) return 'null';
    if (Array.isArray(input)) return ['array', ...input.slice(0, 16).map(normalize)];
    if (typeof input !== 'object') return typeof input;
    return Object.keys(input).sort().map((key) => [key, normalize(input[key])]);
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function routePattern(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (/^v\d+$/.test(segments[0] || '')) segments.shift();
  return `/${segments.map((segment, index) => {
    const previous = segments[index - 1];
    if (RESOURCES.has(previous) || /^[0-9a-f]{8,}$/i.test(segment) || /^\d+$/.test(segment)) return ':id';
    return segment;
  }).join('/')}` || '/';
}

function versionFromRequest(request) {
  const path = new URL(request.url || '/', 'http://localhost').pathname.match(/^\/(v\d+)(?:\/|$)/)?.[1];
  const header = String(request.headers.accept || '').match(/application\/vnd\.forge\.(v\d+)\+json/i)?.[1];
  return path || header || request.headers['x-api-version'] || null;
}

function json(response, status, body) {
  if (response.headersSent) return false;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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

function createGovernance({ pool, logger = console, required = Boolean(pool) } = {}) {
  let schemaReady;
  const ensureSchema = async () => {
    if (!pool) return false;
    if (!schemaReady) schemaReady = pool.query("SELECT to_regclass('forge_api_contracts') AS table_name").then((r) => Boolean(r.rows[0]?.table_name)).catch(() => false);
    return schemaReady;
  };
  const usage = async ({ route, version, status, auth, rejected }) => {
    if (!(await ensureSchema())) return;
    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    await pool.query(`INSERT INTO forge_api_usage(bucket_start,route_identity,api_version,tenant_id,plan_key,status_class,request_count,deprecated_count,rejected_count)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8) ON CONFLICT(bucket_start,route_identity,api_version,tenant_id,plan_key,status_class)
      DO UPDATE SET request_count=forge_api_usage.request_count+1,deprecated_count=forge_api_usage.deprecated_count+EXCLUDED.deprecated_count,rejected_count=forge_api_usage.rejected_count+EXCLUDED.rejected_count,last_seen_at=now()`,
      [bucket, route, version, auth?.tenantId || '', auth?.planKey || '', Math.min(5, Math.max(1, Math.floor(status / 100))), version === 'v1' ? 1 : 0, rejected ? 1 : 0]);
  };
  const consumer = async ({ request, route, version, status, auth }) => {
    if (!(await ensureSchema())) return;
    const key = String(request.headers['x-api-consumer'] || request.headers['user-agent'] || 'unknown').slice(0, 256);
    await pool.query(`INSERT INTO forge_api_consumers(consumer_key,tenant_id,project_id,plan_key,actor_id,declared_version,last_route_identity,last_status,request_count,deprecated_request_count,rejected_request_count)
      VALUES($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,1,$9,$10)
      ON CONFLICT(consumer_key,tenant_id,project_id) DO UPDATE SET last_seen_at=now(),last_route_identity=EXCLUDED.last_route_identity,last_status=EXCLUDED.last_status,declared_version=COALESCE(EXCLUDED.declared_version,forge_api_consumers.declared_version),request_count=forge_api_consumers.request_count+1,deprecated_request_count=forge_api_consumers.deprecated_request_count+EXCLUDED.deprecated_request_count,rejected_request_count=forge_api_consumers.rejected_request_count+EXCLUDED.rejected_request_count`,
      [key, auth?.tenantId || '', request.headers['x-project-id'] || '', auth?.planKey || '', auth?.actor || null, version, route, status, version === 'v1' ? 1 : 0, status >= 400 ? 1 : 0]);
  };
  const ensureContract = async ({ request, version, route, requestFingerprint }) => {
    if (!(await ensureSchema())) return null;
    const sunset = version === 'v1' ? new Date(DEFAULT_SUNSET) : null;
    const result = await pool.query(`INSERT INTO forge_api_contracts(route_identity,method,path_pattern,api_version,request_schema_fingerprint,response_schema_fingerprint,status,activated_at,deprecated_at,sunset_at,compatibility_mode,migration_notes,version_policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13)
      ON CONFLICT(route_identity,api_version) DO UPDATE SET updated_at=now() RETURNING *`,
      [route, request.method, route.slice(route.indexOf(' ') + 1), version, requestFingerprint, fingerprint({ pending: true }), version === 'v1' ? 'deprecated' : 'supported', version === 'v1' ? new Date() : null, sunset, sunset, version === 'v1' ? 'legacy-adapter' : 'additive', 'Live contract; seed/finalize schemas from checked-in OpenAPI before release.', JSON.stringify({ unknownFields: 'additive', durableSemantics: 'protected' })]);
    return result.rows[0];
  };
  const enforce = async ({ request, version, route, auth }) => {
    if (!(await ensureSchema())) { if (required) throw Object.assign(new Error('API contract governance storage is unavailable'), { statusCode: 503, code: 'API_CONTRACT_UNAVAILABLE' }); return; }
    if (!SUPPORTED.has(version)) throw Object.assign(new Error(`Unsupported API version: ${version}`), { statusCode: 406, code: 'UNSUPPORTED_API_VERSION' });
    const plan = auth?.planKey || request.headers['x-plan-key'] || null;
    const policy = await pool.query(`SELECT state FROM forge_api_version_policies WHERE api_version=$1 AND (tenant_id IS NULL OR tenant_id=$2) AND (plan_key IS NULL OR plan_key=$3) AND effective_at<=now() AND (expires_at IS NULL OR expires_at>now()) ORDER BY (tenant_id IS NOT NULL) DESC,(plan_key IS NOT NULL) DESC,effective_at DESC LIMIT 1`, [version, auth?.tenantId || null, plan]);
    if (policy.rows[0]?.state === 'disabled' || policy.rows[0]?.state === 'migration-only') throw Object.assign(new Error(`API version ${version} is not enabled for this consumer`), { statusCode: 410, code: 'API_VERSION_NOT_AVAILABLE' });
    const contract = await ensureContract({ request, version, route, requestFingerprint: request._forgeRequestSchemaFingerprint || fingerprint({}) });
    if (contract?.status === 'disabled' || contract?.status === 'sunset' || (contract?.sunset_at && new Date(contract.sunset_at) <= new Date() && contract.status !== 'sunset-exempt')) throw Object.assign(new Error(`API contract ${version} has reached its sunset boundary`), { statusCode: 410, code: contract.status === 'disabled' ? 'API_ROUTE_DISABLED' : 'API_VERSION_SUNSET' });
    return contract;
  };
  async function operator(request, response) {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith(OPERATOR_PREFIX)) return false;
    const auth = operatorAuth(request); if (!auth) return json(response, 403, { error: { code: 'FORBIDDEN', message: 'Operator role required' } });
    if (!(await ensureSchema())) return json(response, 503, { error: { code: 'API_CONTRACT_UNAVAILABLE' } });
    if (request.method === 'GET' && pathname === OPERATOR_PREFIX) return json(response, 200, { items: (await pool.query('SELECT * FROM forge_api_contracts ORDER BY route_identity,api_version')).rows });
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/consumers`) return json(response, 200, { items: (await pool.query('SELECT * FROM forge_api_consumers ORDER BY last_seen_at DESC LIMIT 500')).rows });
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/history`) return json(response, 200, { items: (await pool.query('SELECT * FROM forge_api_contract_history ORDER BY created_at DESC LIMIT 500')).rows });
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/readiness`) {
      const [contracts, overdue, legacy] = await Promise.all([pool.query('SELECT count(*)::int AS count FROM forge_api_contracts'),pool.query("SELECT count(*)::int AS count FROM forge_api_contracts WHERE sunset_at<=now() AND status NOT IN ('sunset','disabled')"),pool.query("SELECT coalesce(sum(request_count),0)::bigint AS count FROM forge_api_usage WHERE api_version='v1' AND bucket_start>now()-interval '24 hours'")]);
      const ready = contracts.rows[0].count > 0 && overdue.rows[0].count === 0; return json(response, ready ? 200 : 503, { ready, contracts: contracts.rows[0].count, overdueSunsets: overdue.rows[0].count, legacyRequests24h: legacy.rows[0].count });
    }
    if (request.method === 'POST' && pathname === `${OPERATOR_PREFIX}/diff`) {
      let raw=''; request.on('data',(c)=>{raw+=c;}); await new Promise((resolve)=>request.on('end',resolve)); let input; try{input=JSON.parse(raw||'{}');}catch{return json(response,400,{error:{code:'MALFORMED_JSON'}});}
      const [from,to]=await Promise.all([pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2',[input.routeIdentity,input.fromVersion]),pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2',[input.routeIdentity,input.toVersion])]);
      if(!from.rows[0]||!to.rows[0]) return json(response,404,{error:{code:'CONTRACT_NOT_FOUND'}});
      const breaking=from.rows[0].request_schema_fingerprint!==to.rows[0].request_schema_fingerprint||from.rows[0].response_schema_fingerprint!==to.rows[0].response_schema_fingerprint;
      return json(response,breaking?409:200,{compatible:!breaking,breaking,from:from.rows[0],to:to.rows[0]});
    }
    return json(response, 404, { error: { code: 'NOT_FOUND' } });
  }
  const wrap = (listener) => async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname.startsWith(OPERATOR_PREFIX)) return operator(request, response);
    const version = versionFromRequest(request); if (!version || !/^v\d+$/.test(version)) return listener(request, response);
    const route = `${request.method} ${routePattern(pathname)}`; request._forgeApiContractRoute = route;
    let auth = request._auth; if (!auth) { try { const { authenticate } = require('../security/http-security'); auth = authenticate(request,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null}); } catch {} }
    try { await enforce({ request, version, route, auth }); } catch (error) { await consumer({request,route,version,status:error.statusCode||400,auth}).catch(()=>{}); await usage({route,version,status:error.statusCode||400,auth,rejected:true}).catch(()=>{}); return json(response,error.statusCode||400,{error:{code:error.code||'API_CONTRACT_REJECTED',message:error.message},requestId:request.headers['x-request-id']||null}); }
    const originalEnd=response.end; response.end=function governanceEnd(chunk,encoding,callback){ const status=response.statusCode||200; consumer({request,route,version,status,auth}).catch((e)=>logger.warn?.('api consumer telemetry failed',e.message)); usage({route,version,status,auth,rejected:status>=400}).catch((e)=>logger.warn?.('api usage telemetry failed',e.message)); return originalEnd.call(this,chunk,encoding,callback); };
    return listener(request,response);
  };
  return { wrap, operator, ensureSchema };
}

function installApiContractGovernance(options = {}) {
  if (http[INSTALLED]) return http[INSTALLED];
  let pool = options.pool || null;
  if (!pool && process.env.DATABASE_URL) { try { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }); } catch {} }
  const governance=createGovernance({pool,logger:options.logger,required:options.required??Boolean(pool)});
  const originalCreateServer=http.createServer;
  http.createServer=function forgeGovernedCreateServer(requestListener){ const server=originalCreateServer.call(this); const originalOn=server.on.bind(server),originalAddListener=server.addListener.bind(server); server.on=(event,listener)=>originalOn(event,event==='request'?governance.wrap(listener):listener); server.addListener=(event,listener)=>originalAddListener(event,event==='request'?governance.wrap(listener):listener); if(requestListener)server.on('request',requestListener); return server; };
  http[INSTALLED]=governance; return governance;
}

module.exports={fingerprint,routePattern,installApiContractGovernance,createGovernance};
