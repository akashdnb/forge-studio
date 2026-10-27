'use strict';

const { URL } = require('node:url');
const { authenticate, hasRole } = require('../security/http-security');
const { CredentialAccessService } = require('./credential-access-service');

function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readJson(req) { const chunks=[]; let size=0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw Object.assign(new Error('Request body exceeds 1 MiB'), { code:'REQUEST_TOO_LARGE', statusCode:413 }); chunks.push(chunk); } if (!chunks.length) return {}; try { const body=JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Malformed JSON'), { code:'INVALID_JSON', statusCode:400 }); } }
function ownerOnly(auth, hasRole, tenantId) { if (!auth?.tenantId || auth.tenantId !== tenantId) throw Object.assign(new Error('Tenant access denied'), { code:'FORBIDDEN', statusCode:403 }); if (!hasRole(auth.actor, 'OWNER')) throw Object.assign(new Error('Credential lease administration requires OWNER role'), { code:'FORBIDDEN', statusCode:403 }); }
function runnerOnly(req) { const token=String(req.headers.authorization || '').replace(/^Bearer\s+/i,''); if (!token) throw Object.assign(new Error('Scoped grant required'), { code:'GRANT_REQUIRED', statusCode:401 }); return token; }
function mapError(error) { return { status:error.statusCode || (error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 422), body:{ error:{ code:error.code || 'CREDENTIAL_ACCESS_ERROR', message:error.message } } }; }

async function handleCredentialAccessRequest(req, res, { service, auth = null, hasRole: roleCheck = () => false, requestId = null } = {}) {
  const url = new URL(req.url || '/', 'http://localhost'); if (!url.pathname.startsWith('/internal/providers/credential-access')) return false;
  try {
    if (!service) throw Object.assign(new Error('credential access boundary unavailable'), { code:'SERVICE_UNAVAILABLE', statusCode:503 });
    if (url.pathname === '/internal/providers/credential-access/execute' && req.method === 'POST') {
      const grant = runnerOnly(req); const body = await readJson(req);
      const result = await service.execute({ grant, request:{ url:body.url, method:body.method || 'POST', body:body.body }, expected:{ tenantId:body.tenantId, projectId:body.projectId || null, provider:body.provider, model:body.model || '', purpose:body.purpose, region:body.region, executionEpoch:body.executionEpoch }, requestId, timeoutMs:body.timeoutMs });
      return send(res, result.status || 200, { ok:result.ok, body:result.body, provider:result.provider, credentialVersion:result.credentialVersion, attestation:result.attestation });
    }
    const tenantId = url.searchParams.get('tenantId'); if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code:'INVALID_REQUEST', statusCode:400 }); ownerOnly(auth, roleCheck, tenantId);
    if (req.method === 'GET' && url.pathname === '/internal/providers/credential-access/leases') return send(res,200,{items:await service.listLeases({tenantId,projectId:url.searchParams.get('projectId'),state:url.searchParams.get('state'),limit:url.searchParams.get('limit')||100})});
    if (req.method === 'GET' && url.pathname === '/internal/providers/credential-access/history') return send(res,200,{items:await service.history({tenantId,projectId:url.searchParams.get('projectId'),leaseId:url.searchParams.get('leaseId'),limit:url.searchParams.get('limit')||100})});
    if (req.method === 'GET' && url.pathname === '/internal/providers/credential-access/health') return send(res,200,{ok:true,region:service.region,executionEpoch:service.executionEpoch,active:(await service.listLeases({tenantId,limit:1})).length});
    const match=/^\/internal\/providers\/credential-access\/leases\/([^/]+)\/(renew|release|revoke)$/.exec(url.pathname);
    if (match && req.method === 'POST') { const body=await readJson(req); if (match[2] === 'renew') return send(res,200,{item:await service.renew({tenantId,leaseId:decodeURIComponent(match[1]),fencingToken:body.fencingToken,leaseSeconds:body.leaseSeconds})}); if (match[2] === 'release') return send(res,200,{item:await service.release({tenantId,leaseId:decodeURIComponent(match[1]),fencingToken:body.fencingToken,reason:body.reason || 'operator release'})}); return send(res,200,{item:await service.revoke({tenantId,leaseId:decodeURIComponent(match[1]),actor:auth.actor,reason:body.reason || 'operator revoked'})}); }
    if (req.method === 'POST' && url.pathname === '/internal/providers/credential-access/cleanup') return send(res,200,{item:await service.cleanup({limit:(await readJson(req)).limit || 200})});
    return send(res,404,{error:{code:'NOT_FOUND',message:'Credential access route not found'}});
  } catch (error) { const mapped=mapError(error); return send(res,mapped.status,{...mapped.body,requestId}); }
}

module.exports={handleCredentialAccessRequest};
