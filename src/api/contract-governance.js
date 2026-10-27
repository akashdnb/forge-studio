const { createHash } = require('node:crypto');
const { URL } = require('node:url');
const http = require('node:http');

const INSTALLED = Symbol.for('forge.apiContractGovernance');
const SUPPORTED = new Set(['v1', 'v2']);
const DEFAULT_SUNSET = process.env.FORGE_API_V1_SUNSET || '2027-04-27T00:00:00Z';
const OPERATOR_PREFIX = '/internal/api-contracts';

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
  if (segments[0] && /^v\d+$/.test(segments[0])) segments.shift();
  return `/${segments.map((segment, index) => {
    if (/^[0-9a-f]{8,}$/i.test(segment) || /^\d+$/.test(segment)) return `:param${index}`;
    if (['episodes', 'projects', 'jobs', 'versions', 'artifacts', 'providers', 'usage', 'bundles', 'reviews', 'evidence'].includes(segment) && index + 1 < segments.length) return segment;
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
    const auth = request._auth || authenticate(request, {
      apiToken: process.env.API_BEARER_TOKEN || null,
      authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null,
      staticActor: process.env.FORGE_STATIC_ACTOR_ID || null,
      staticTenant: process.env.FORGE_STATIC_TENANT_ID || null,
    });
    return auth && hasRole(auth, 'OWNER') ? auth : null;
  } catch { return null; }
}

function createGovernance({ pool, logger = console, required = Boolean(pool) } = {}) {
  let schemaReady = null;
  const ensureSchema = async () => {
    if (!pool) return false;
    if (!schemaReady) {
      schemaReady = pool.query('SELECT to_regclass(\'forge_api_contracts\') AS table_name').then((r) => Boolean(r.rows[0]?.table_name)).catch(() => false);
    }
    return schemaReady;
  };

  const upsertConsumer = async ({ request, version, route, status, auth }) => {
    if (!(await ensureSchema())) return;
    const tenant = auth?.tenantId || '';
    const project = request.headers['x-project-id'] || '';
    const consumer = String(request.headers['x-api-consumer'] || request.headers['user-agent'] || 'unknown').slice(0, 256);
    const plan = String(auth?.planKey || request.headers['x-plan-key'] || '').slice(0, 128);
    await pool.query(`INSERT INTO forge_api_consumers (consumer_key,tenant_id,project_id,plan_key,actor_id,declared_version,last_route_identity,last_status,request_count,deprecated_request_count,rejected_request_count)
      VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,1,$9,$10)
      ON CONFLICT (consumer_key,tenant_id,project_id) DO UPDATE SET last_seen_at=now(),last_route_identity=EXCLUDED.last_route_identity,last_status=EXCLUDED.last_status,declared_version=COALESCE(EXCLUDED.declared_version,forge_api_consumers.declared_version),plan_key=COALESCE(EXCLUDED.plan_key,forge_api_consumers.plan_key),request_count=forge_api_consumers.request_count+1,deprecated_request_count=forge_api_consumers.deprecated_request_count+EXCLUDED.deprecated_request_count,rejected_request_count=forge_api_consumers.rejected_request_count+EXCLUDED.rejected_request_count`,
      [consumer, tenant, project, plan, auth?.actor || null, version, route, status, version === 'v1' ? 1 : 0, status >= 400 ? 1 : 0]);
  };

  const recordUsage = async ({ route, version, status, auth, deprecated, rejected }) => {
    if (!(await ensureSchema())) return;
    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const tenant = auth?.tenantId || '';
    const plan = auth?.planKey || '';
    await pool.query(`INSERT INTO forge_api_usage (bucket_start,route_identity,api_version,tenant_id,plan_key,status_class,request_count,deprecated_count,rejected_count)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)
      ON CONFLICT (bucket_start,route_identity,api_version,tenant_id,plan_key,status_class) DO UPDATE SET request_count=forge_api_usage.request_count+1,deprecated_count=forge_api_usage.deprecated_count+EXCLUDED.deprecated_count,rejected_count=forge_api_usage.rejected_count+EXCLUDED.rejected_count,last_seen_at=now()`,
      [bucket, route, version, tenant, plan, Math.min(5, Math.max(1, Math.floor(status / 100))), deprecated ? 1 : 0, rejected ? 1 : 0]);
  };

  const ensureContract = async ({ request, version, route, requestFingerprint }) => {
    if (!(await ensureSchema())) return null;
    const result = await pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2 FOR UPDATE', [route, version]);
    if (result.rows[0]) return result.rows[0];
    const sunset = version === 'v1' ? DEFAULT_SUNSET : null;
    const inserted = await pool.query(`INSERT INTO forge_api_contracts (route_identity,method,path_pattern,api_version,request_schema_fingerprint,response_schema_fingerprint,status,activated_at,deprecated_at,sunset_at,compatibility_mode,migration_notes,version_policy)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12) RETURNING *`,
      [route, request.method, route.split(' ')[1] || route, version, requestFingerprint, fingerprint({ pending: true }), version === 'v1' ? 'deprecated' : 'supported', version === 'v1' ? new Date(Date.now() - 1) : null, sunset ? new Date(Date.now() - 1) : null, sunset ? new Date(sunset) : null, version === 'v1' ? 'legacy-adapter' : 'additive', 'Auto-registered from live route; operator should finalize request/response schemas.', JSON.stringify({ activation: 'live', unknownFields: 'additive' })]);
    await pool.query('INSERT INTO forge_api_contract_history(contract_id,action,actor_id,before_state,after_state,reason) VALUES($1,$2,$3,$4,$5,$6)', [inserted.rows[0].id, 'registered', request.headers['x-actor-id'] || null, null, JSON.stringify(inserted.rows[0]), 'first live observation']);
    return inserted.rows[0];
  };

  const enforcePolicy = async ({ request, version, route, auth }) => {
    if (!(await ensureSchema())) {
      if (required) throw Object.assign(new Error('API contract governance storage is unavailable'), { statusCode: 503, code: 'API_CONTRACT_UNAVAILABLE' });
      return null;
    }
    if (!SUPPORTED.has(version)) throw Object.assign(new Error(`Unsupported API version: ${version}`), { statusCode: 406, code: 'UNSUPPORTED_API_VERSION' });
    const consumerPlan = auth?.planKey || request.headers['x-plan-key'] || null;
    const policy = await pool.query(`SELECT state FROM forge_api_version_policies WHERE api_version=$1 AND (tenant_id IS NULL OR tenant_id=$2) AND (plan_key IS NULL OR plan_key=$3) AND effective_at <= now() AND (expires_at IS NULL OR expires_at > now()) ORDER BY (tenant_id IS NOT NULL) DESC,(plan_key IS NOT NULL) DESC,effective_at DESC LIMIT 1`, [version, auth?.tenantId || null, consumerPlan]);
    if (policy.rows[0] && ['disabled', 'migration-only'].includes(policy.rows[0].state)) throw Object.assign(new Error(`API version ${version} is not enabled for this consumer`), { statusCode: 410, code: 'API_VERSION_NOT_AVAILABLE' });
    const bodyFingerprint = request._forgeRequestSchemaFingerprint || fingerprint({});
    const contract = await ensureContract({ request, version, route, requestFingerprint: bodyFingerprint });
    if (contract?.status === 'sunset' || (contract?.sunset_at && new Date(contract.sunset_at) <= new Date() && contract.status !== 'sunset-exempt')) throw Object.assign(new Error(`API contract ${version} has reached its sunset date`), { statusCode: 410, code: 'API_VERSION_SUNSET' });
    if (contract?.status === 'disabled') throw Object.assign(new Error('API route is disabled'), { statusCode: 410, code: 'API_ROUTE_DISABLED' });
    return contract;
  };

  async function handleOperator(request, response) {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith(OPERATOR_PREFIX)) return false;
    const auth = operatorAuth(request);
    if (!auth) return json(response, 403, { error: { code: 'FORBIDDEN', message: 'Operator role required' } });
    if (!(await ensureSchema())) return json(response, 503, { error: { code: 'API_CONTRACT_UNAVAILABLE' } });
    if (request.method === 'GET' && pathname === OPERATOR_PREFIX) {
      const result = await pool.query('SELECT route_identity,method,path_pattern,api_version,status,activated_at,deprecated_at,sunset_at,compatibility_mode,tenant_scope,plan_scope,migration_notes,request_schema_fingerprint,response_schema_fingerprint,updated_at FROM forge_api_contracts ORDER BY route_identity,api_version');
      return json(response, 200, { items: result.rows });
    }
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/consumers`) {
      const result = await pool.query('SELECT consumer_key,tenant_id,project_id,plan_key,declared_version,first_seen_at,last_seen_at,last_route_identity,last_status,request_count,deprecated_request_count,rejected_request_count FROM forge_api_consumers ORDER BY last_seen_at DESC LIMIT 500');
      return json(response, 200, { items: result.rows });
    }
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/readiness`) {
      const [contracts, sunset, legacy] = await Promise.all([
        pool.query("SELECT count(*)::int AS count FROM forge_api_contracts"),
        pool.query("SELECT count(*)::int AS count FROM forge_api_contracts WHERE sunset_at IS NOT NULL AND sunset_at <= now() AND status NOT IN ('sunset','disabled')"),
        pool.query("SELECT count(*)::int AS count FROM forge_api_usage WHERE api_version='v1' AND bucket_start > now() - interval '24 hours'"),
      ]);
      const ready = contracts.rows[0].count > 0 && sunset.rows[0].count === 0;
      return json(response, ready ? 200 : 503, { ready, contracts: contracts.rows[0].count, overdueSunsets: sunset.rows[0].count, legacyUsageBuckets24h: legacy.rows[0].count });
    }
    if (request.method === 'GET' && pathname === `${OPERATOR_PREFIX}/history`) {
      const result = await pool.query('SELECT * FROM forge_api_contract_history ORDER BY created_at DESC LIMIT 500');
      return json(response, 200, { items: result.rows });
    }
    if (request.method === 'POST' && pathname === `${OPERATOR_PREFIX}/diff`) {
      const result = await new Promise((resolve) => {
        let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => resolve(body));
      });
      let input; try { input = JSON.parse(result || '{}'); } catch { return json(response, 400, { error: { code: 'MALFORMED_JSON' } }); }
      const left = await pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2', [input.routeIdentity, input.fromVersion]);
      const right = await pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2', [input.routeIdentity, input.toVersion]);
      if (!left.rows[0] || !right.rows[0]) return json(response, 404, { error: { code: 'CONTRACT_NOT_FOUND' } });
      const breaking = left.rows[0].request_schema_fingerprint !== right.rows[0].request_schema_fingerprint || left.rows[0].response_schema_fingerprint !== right.rows[0].response_schema_fingerprint;
      return json(response, 200, { compatible: !breaking, breaking, from: left.rows[0], to: right.rows[0], reason: breaking ? 'schema fingerprint changed; explicit compatibility review required' : 'schema fingerprints match' });
    }
    return json(response, 404, { error: { code: 'NOT_FOUND' } });
  }

  const wrap = (listener) => async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname.startsWith(OPERATOR_PREFIX)) return handleOperator(request, response);
    const version = versionFromRequest(request);
    if (!version || !/^v\d+$/.test(version)) return listener(request, response);
    const route = `${request.method} ${routePattern(pathname)}`;
    request._forgeApiContractRoute = route;
    request._forgeRequestSchemaFingerprint = fingerprint(request._forgeParsedBody || {});
    let auth = request._auth;
    if (!auth) {
      try {
        const { authenticate } = require('../security/http-security');
        auth = authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
      } catch {}
    }
    try {
      await enforcePolicy({ request, version, route, auth });
    } catch (error) {
      await upsertConsumer({ request, version, route, status: error.statusCode || 400, auth }).catch(() => {});
      await recordUsage({ route, version, status: error.statusCode || 400, auth, deprecated: version === 'v1', rejected: true }).catch(() => {});
      if (!response.headersSent) json(response, error.statusCode || 400, { error: { code: error.code || 'API_CONTRACT_REJECTED', message: error.message }, requestId: request.headers['x-request-id'] || null });
      return;
    }
    const originalEnd = response.end;
    response.end = function governanceEnd(chunk, encoding, callback) {
      const status = response.statusCode || 200;
      upsertConsumer({ request, version, route, status, auth }).catch((error) => logger.warn?.('api consumer telemetry failed', error.message));
      recordUsage({ route, version, status, auth, deprecated: version === 'v1', rejected: status >= 400 }).catch((error) => logger.warn?.('api usage telemetry failed', error.message));
      return originalEnd.call(this, chunk, encoding, callback);
    };
    return listener(request, response);
  };

  return { wrap, handleOperator, ensureSchema };
}

function installApiContractGovernance(options = {}) {
  if (http[INSTALLED]) return;
  let pool = options.pool || null;
  if (!pool && process.env.DATABASE_URL) {
    try { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }); } catch {}
  }
  const governance = createGovernance({ pool, logger: options.logger, required: options.required ?? Boolean(pool) });
  const originalCreateServer = http.createServer;
  http.createServer = function forgeGovernedCreateServer(requestListener) {
    const server = originalCreateServer.call(this);
    const originalOn = server.on.bind(server);
    const originalAddListener = server.addListener.bind(server);
    const add = (event, listener) => originalOn(event, event === 'request' ? governance.wrap(listener) : listener);
    server.on = add;
    server.addListener = (event, listener) => originalAddListener(event, event === 'request' ? governance.wrap(listener) : listener);
    if (requestListener) server.on('request', requestListener);
    return server;
  };
  http[INSTALLED] = governance;
  return governance;
}

module.exports = { fingerprint, routePattern, installApiContractGovernance, createGovernance };
