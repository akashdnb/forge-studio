'use strict';
const http = require('node:http');
const { Pool } = require('pg');
const { authenticate, hasRole } = require('../security/http-security');
const { ProviderContractService, redact } = require('./provider-contract-service');
const installed = Symbol.for('forge.provider.contracts.http.installed');
if (!http.Server.prototype[installed] && process.env.DATABASE_URL && process.env.FORGE_PROVIDER_CONTRACT_SIGNING_SECRET) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_CONTRACT_POOL_MAX || '3', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  const service = new ProviderContractService({ pool });
  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function providerContractControlPlaneOn(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this, event, listener);
    const wrapped = async (request, response) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/internal/providers/contracts')) return listener(request, response);
      const auth = authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
      if (!auth) { response.statusCode=401; response.setHeader('content-type','application/json; charset=utf-8'); return response.end(JSON.stringify({error:{code:'UNAUTHORIZED'}})); }
      const operator = hasRole(auth, 'operator') || hasRole(auth, 'admin');
      const requestId = request.headers['x-request-id'] || require('node:crypto').randomUUID();
      const send = (status, body) => { response.statusCode=status; response.setHeader('content-type','application/json; charset=utf-8'); response.setHeader('x-request-id',requestId); response.end(JSON.stringify(body)); };
      try {
        if (request.method === 'GET' && url.pathname === '/internal/providers/contracts') return send(200, { contracts: (await pool.query(`SELECT id,provider,capability,contract_version,contract_hash,schema_version,status,valid_until,updated_by,created_at,updated_at FROM forge_provider_contracts WHERE ($1::text IS NULL OR provider=$1) AND ($2::text IS NULL OR capability=$2) ORDER BY provider,capability,contract_version DESC`, [url.searchParams.get('provider'), url.searchParams.get('capability')])).rows });
        if (!operator) return send(403, {error:{code:'FORBIDDEN'}});
        let body=''; for await (const chunk of request) body += chunk; const payload=body ? JSON.parse(body) : {};
        if (request.method === 'POST' && url.pathname === '/internal/providers/contracts') return send(200, { contract: await service.upsert({ contract: redact(payload.contract), actor: auth.actor || 'operator' }) });
        if (request.method === 'POST' && url.pathname === '/internal/providers/contracts/quarantine/clear') { await service.clearQuarantine(payload.provider,payload.capability,auth.actor||'operator'); return send(200,{ok:true}); }
        if (request.method === 'GET' && url.pathname === '/internal/providers/contracts/state') return send(200,{state:await service.state(url.searchParams.get('provider'),url.searchParams.get('capability'))});
        return send(404,{error:{code:'NOT_FOUND'}});
      } catch(error) { return send(error.statusCode||500,{error:{code:error.code||'CONTRACT_CONTROL_ERROR',message:error.message}}); }
    };
    return originalOn.call(this,event,wrapped);
  };
  http.Server.prototype[installed]={pool,service};
  setImmediate(async()=>{ try { await service.startupValidate(); } catch(error) { console.error(JSON.stringify({type:'provider-contract.startup-failed',code:error.code,message:error.message,details:error.details})); process.exitCode=1; } });
}
module.exports={installed};
