'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { authenticate, hasRole, safeError } = require('../security/http-security');

const installed = Symbol.for('forge.artifact.delivery.http.installed');
const gatewaySymbol = Symbol.for('forge.artifact.delivery.gateway');

function json(res, status, body, requestId) { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId }); res.end(JSON.stringify(body)); }
async function body(req) { let raw=''; for await (const chunk of req) raw += chunk; if (!raw) return {}; try { return JSON.parse(raw); } catch { const e=new Error('invalid JSON'); e.code='INVALID_JSON'; e.statusCode=400; throw e; } }
function auth(req) { return authenticate(req,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null}); }

if (!http.Server.prototype[installed]) {
  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function artifactDeliveryControlPlaneOn(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this,event,listener);
    const wrapped = async (request,response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/internal/artifact-delivery/')) return listener(request,response);
      const requestId = request.headers['x-request-id'] || randomUUID();
      const gateway = globalThis[gatewaySymbol];
      if (!gateway?.grantService) return json(response,503,{error:{code:'DELIVERY_AUTH_UNAVAILABLE'}},requestId);
      const principal = auth(request);
      if (!principal) return safeError(response,401,'UNAUTHORIZED',requestId);
      if (!hasRole(principal,'OWNER')) return safeError(response,403,'FORBIDDEN',requestId);
      try {
        const grantService=gateway.grantService, url=new URL(request.url||'/', 'http://localhost');
        if (request.method==='GET' && pathname==='/internal/artifact-delivery/health') return json(response,200,{data:await grantService.health({tenantId:principal.tenantId})},requestId);
        if (request.method==='GET' && pathname==='/internal/artifact-delivery/metrics') return json(response,200,{data:gateway.kms?.metrics?.snapshot?.()||null},requestId);
        const grantMatch=/^\/internal\/artifact-delivery\/grants\/([^/]+)$/.exec(pathname);
        if (grantMatch && request.method==='GET') { const item=await grantService.inspect({grantId:decodeURIComponent(grantMatch[1])}); if(item.tenant_id!==principal.tenantId) return safeError(response,403,'FORBIDDEN',requestId); return json(response,200,{data:item},requestId); }
        if (grantMatch && request.method==='DELETE') { const item=await grantService.inspect({grantId:decodeURIComponent(grantMatch[1])}); if(item.tenant_id!==principal.tenantId) return safeError(response,403,'FORBIDDEN',requestId); return json(response,200,{data:await grantService.revoke({grantId:decodeURIComponent(grantMatch[1]),actor:principal.actor,reason:url.searchParams.get('reason')||'operator revocation'})},requestId); }
        if (request.method==='POST' && pathname==='/internal/artifact-delivery/deny') { const input=await body(request); if(input.scopeType!=='TENANT' && !input.scopeId) throw Object.assign(new Error('scopeId is required'),{code:'INVALID_REQUEST',statusCode:400}); if(input.scopeType!=='TENANT' && input.scopeType!=='PROJECT' && input.scopeType!=='ARTIFACT' && input.scopeType!=='GRANT') throw Object.assign(new Error('invalid scopeType'),{code:'INVALID_REQUEST',statusCode:400}); return json(response,200,{data:await grantService.deny({tenantId:principal.tenantId,projectId:input.projectId||null,scopeType:input.scopeType,scopeId:input.scopeId||principal.tenantId,actor:principal.actor,reason:input.reason||'operator denylist'})},requestId); }
        if (request.method==='POST' && pathname==='/internal/artifact-delivery/rotate') { if(!gateway.kms) throw Object.assign(new Error('KMS signing is not configured'),{code:'KMS_REQUIRED',statusCode:503}); const input=await body(request); return json(response,200,{data:await gateway.kms.rotate({tenantId:principal.tenantId,projectId:input.projectId||null,purpose:'capability-token',actor:principal.actor,reason:input.reason||'artifact delivery signing rotation',expectedEpoch:input.expectedEpoch??null})},requestId); }
        if (request.method==='POST' && pathname==='/internal/artifact-delivery/revoke-key') { if(!gateway.kms) throw Object.assign(new Error('KMS signing is not configured'),{code:'KMS_REQUIRED',statusCode:503}); const input=await body(request); return json(response,200,{data:await gateway.kms.revoke({tenantId:principal.tenantId,projectId:input.projectId||null,purpose:'capability-token',epoch:Number(input.epoch),actor:principal.actor,reason:input.reason||'artifact delivery signing key revocation'})},requestId); }
        return json(response,404,{error:{code:'NOT_FOUND'}},requestId);
      } catch(error) { return json(response,error.statusCode||500,{error:{code:error.code||'ARTIFACT_DELIVERY_OPERATOR_ERROR',message:error.message},requestId},requestId); }
    };
    return originalOn.call(this,event,wrapped);
  };
  http.Server.prototype[installed]=true;
}
module.exports={installed};
