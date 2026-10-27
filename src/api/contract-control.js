const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const INSTALLED = Symbol.for('forge.apiContractControl');

function send(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function body(request) {
  return new Promise((resolve, reject) => {
    let raw = ''; request.on('data', (chunk) => { raw += chunk; if (raw.length > 1024 * 1024) reject(new Error('body too large')); });
    request.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(Object.assign(new Error('Malformed JSON request body'), { code: 'MALFORMED_JSON', statusCode: 400 })); } });
    request.on('error', reject);
  });
}

function installApiContractControls({ pool } = {}) {
  if (http[INSTALLED] || !pool) return;
  const originalCreateServer = http.createServer;
  http.createServer = function governedCreateServer(requestListener) {
    const server = originalCreateServer.call(this);
    const originalOn = server.on.bind(server);
    const originalAddListener = server.addListener.bind(server);
    const wrap = (listener) => async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (pathname !== '/internal/api-contracts/control' && pathname !== '/internal/api-contracts/migration') return listener(request, response);
      let auth;
      try {
        const { authenticate, hasRole } = require('../security/http-security');
        auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth || !hasRole(auth, 'OWNER')) return send(response, 403, { error: { code: 'FORBIDDEN' } });
      } catch { return send(response, 403, { error: { code: 'FORBIDDEN' } }); }
      try {
        const input = await body(request);
        if (pathname.endsWith('/control')) {
          const action = String(input.action || '');
          const route = String(input.routeIdentity || '');
          const version = String(input.apiVersion || '');
          if (!route || !/^v\d+$/.test(version)) return send(response, 400, { error: { code: 'INVALID_CONTRACT_TARGET' } });
          const current = await pool.query('SELECT * FROM forge_api_contracts WHERE route_identity=$1 AND api_version=$2 FOR UPDATE', [route, version]);
          if (!current.rows[0]) return send(response, 404, { error: { code: 'CONTRACT_NOT_FOUND' } });
          const before = current.rows[0];
          let status = before.status;
          let compatibility = before.compatibility_mode;
          let sunset = before.sunset_at;
          let deprecated = before.deprecated_at;
          if (action === 'activate') { status = 'supported'; compatibility = input.compatibilityMode || compatibility; }
          else if (action === 'deprecate') { status = 'deprecated'; deprecated = input.effectiveAt ? new Date(input.effectiveAt) : new Date(); sunset = input.sunsetAt ? new Date(input.sunsetAt) : sunset; }
          else if (action === 'sunset') { status = 'sunset'; sunset = input.effectiveAt ? new Date(input.effectiveAt) : new Date(); }
          else if (action === 'rollback') { status = input.previousStatus || 'supported'; }
          else return send(response, 400, { error: { code: 'INVALID_CONTRACT_ACTION' } });
          const updated = await pool.query('UPDATE forge_api_contracts SET status=$1,compatibility_mode=$2,deprecated_at=$3,sunset_at=$4,version_policy=version_policy || $5::jsonb WHERE id=$6 RETURNING *', [status, compatibility, deprecated, sunset, JSON.stringify({ lastAction: action, controlledAt: new Date().toISOString() }), before.id]);
          await pool.query('INSERT INTO forge_api_contract_history(contract_id,action,actor_id,tenant_id,before_state,after_state,reason) VALUES($1,$2,$3,$4,$5,$6,$7)', [before.id, action, auth.actor, auth.tenantId || null, JSON.stringify(before), JSON.stringify(updated.rows[0]), String(input.reason || '')]);
          return send(response, 200, { contract: updated.rows[0], rolledBack: action === 'rollback' });
        }
        const route = String(input.routeIdentity || '');
        const fromVersion = String(input.fromVersion || '');
        const toVersion = String(input.toVersion || '');
        if (!route || !/^v\d+$/.test(fromVersion) || !/^v\d+$/.test(toVersion) || fromVersion === toVersion) return send(response, 400, { error: { code: 'INVALID_MIGRATION' } });
        const rows = await pool.query('SELECT api_version,request_schema_fingerprint,response_schema_fingerprint FROM forge_api_contracts WHERE route_identity=$1 AND api_version=ANY($2::text[])', [route, [fromVersion, toVersion]]);
        if (rows.rows.length !== 2) return send(response, 404, { error: { code: 'CONTRACT_NOT_FOUND' } });
        const from = rows.rows.find((row) => row.api_version === fromVersion); const to = rows.rows.find((row) => row.api_version === toVersion);
        const compatible = from.request_schema_fingerprint === to.request_schema_fingerprint && from.response_schema_fingerprint === to.response_schema_fingerprint;
        const id = randomUUID();
        const inserted = await pool.query('INSERT INTO forge_api_migration_runs(id,route_identity,from_version,to_version,tenant_id,consumer_key,state,compatibility_result,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [id, route, fromVersion, toVersion, auth.tenantId || null, input.consumerKey || null, compatible ? 'verified' : 'planned', JSON.stringify({ compatible, requestChanged: from.request_schema_fingerprint !== to.request_schema_fingerprint, responseChanged: from.response_schema_fingerprint !== to.response_schema_fingerprint }), auth.actor]);
        return send(response, compatible ? 200 : 409, { migration: inserted.rows[0], compatible });
      } catch (error) { return send(response, error.statusCode || 500, { error: { code: error.code || 'API_CONTROL_FAILED', message: error.message } }); }
    };
    server.on = (event, listener) => originalOn(event, event === 'request' ? wrap(listener) : listener);
    server.addListener = (event, listener) => originalAddListener(event, event === 'request' ? wrap(listener) : listener);
    if (requestListener) server.on('request', requestListener);
    return server;
  };
  http[INSTALLED] = true;
}

module.exports = { installApiContractControls };
