const http = require('node:http');
const { URL } = require('node:url');
const state = http[Symbol.for('forge.clientContracts')];
if (state && state.pool && !http.__forgeClientConsumerReportInstalled) {
  const { pool, store } = state;
  const json = (response, status, body) => { if (response.headersSent) return false; response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); return true; };
  const authFor = (request) => { try { const { authenticate, hasRole } = require('../security/http-security'); const auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null }); return auth && hasRole(auth, 'OWNER') ? auth : null; } catch { return null; } };
  const originalCreateServer = http.createServer;
  http.createServer = function consumerReportServer(requestListener) {
    const server = originalCreateServer.call(this); const originalOn = server.on.bind(server); const originalAddListener = server.addListener.bind(server);
    const wrap = (listener) => async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (request.method !== 'POST' || pathname !== '/internal/client-contracts/consumers/report') return listener(request, response);
      const auth = authFor(request); if (!auth) return json(response,403,{error:{code:'FORBIDDEN'}});
      let raw=''; for await (const chunk of request) raw += chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(response,400,{error:{code:'MALFORMED_JSON'}}); }
      if (!body.consumerKey) return json(response,400,{error:{code:'CONSUMER_KEY_REQUIRED'}});
      const tenantId=body.tenantId||auth.tenantId||''; const latest=await store.latest(body.apiVersion||'v2'); const compatible=!body.contractFingerprint||!latest||body.contractFingerprint===latest.contract_fingerprint;
      const result=await pool.query(`INSERT INTO forge_client_contract_consumers(consumer_key,tenant_id,declared_api_version,declared_contract_fingerprint,last_seen_at,last_compatible_at,last_incompatible_at,metadata) VALUES($1,$2,$3,$4,now(),CASE WHEN $5 THEN now() ELSE NULL END,CASE WHEN $5 THEN NULL ELSE now() END,$6::jsonb) ON CONFLICT(consumer_key,tenant_id) DO UPDATE SET declared_api_version=EXCLUDED.declared_api_version,declared_contract_fingerprint=EXCLUDED.declared_contract_fingerprint,last_seen_at=now(),last_compatible_at=CASE WHEN $5 THEN now() ELSE forge_client_contract_consumers.last_compatible_at END,last_incompatible_at=CASE WHEN $5 THEN forge_client_contract_consumers.last_incompatible_at ELSE now() END,metadata=EXCLUDED.metadata RETURNING *`,[String(body.consumerKey).slice(0,256),String(tenantId).slice(0,256),body.apiVersion||'v2',body.contractFingerprint||null,compatible,JSON.stringify(body.metadata||{})]);
      return json(response,200,{item:result.rows[0],compatible});
    };
    server.on=(event,listener)=>originalOn(event,event==='request'?wrap(listener):listener); server.addListener=(event,listener)=>originalAddListener(event,event==='request'?wrap(listener):listener); if(requestListener)server.on('request',requestListener); return server;
  };
  http.__forgeClientConsumerReportInstalled=true;
}
