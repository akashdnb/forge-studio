'use strict';

const extended = require('../extended-http-api');
const { authenticate, hasRole } = require('../security/http-security');
const { handlePolicyRequest } = require('./bootstrap');
const { diagnostics, runbook } = require('./diagnostics');

async function readJson(request) { let body=''; for await (const chunk of request) body += chunk; return body ? JSON.parse(body) : {}; }
function writeJson(response,status,body){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));}

if (!extended.__forgePolicyHttpPatched) {
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function createExtendedApiServerWithPolicy(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository) return result;
    const listeners = result.server.listeners.bind(result.server);
    result.server.listeners = function policyListeners(eventName) {
      const current = listeners(eventName);
      if (eventName !== 'request' || !current.length) return current;
      const base = current[0];
      const pool = options.repository.db.pool;
      const wrapped = async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/internal/policy')) return base(request, response);
        const auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (pathname === '/internal/policy/health' || pathname === '/internal/policy/metrics') {
          if (!auth || (!hasRole(auth, 'OWNER') && !hasRole(auth, 'ADMIN') && !hasRole(auth, 'OPERATOR'))) return writeJson(response,403,{error:'FORBIDDEN'});
          const body = await diagnostics(pool, auth.tenantId); return writeJson(response,body.healthy?200:503,body);
        }
        if (pathname === '/internal/policy/runbook') return writeJson(response,200,runbook());
        const rollback = pathname.match(/^\/internal\/policy-bundles\/([^/]+)\/rollback$/);
        if (rollback && request.method === 'POST') {
          if (!auth || (!hasRole(auth, 'OWNER') && !hasRole(auth, 'ADMIN'))) return writeJson(response,403,{error:'FORBIDDEN'});
          const body=await readJson(request); const target=(await pool.query(`SELECT versions,rollout_percent FROM forge_policy_activation_epochs WHERE bundle_id=$1 AND tenant_id=$2 AND epoch=$3`,[rollback[1],auth.tenantId,Number(body.epoch)])).rows[0]; if(!target) return writeJson(response,404,{error:'POLICY_EPOCH_NOT_FOUND'});
          const current=(await pool.query(`SELECT current_epoch FROM forge_policy_bundles WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[rollback[1],auth.tenantId])).rows[0]; if(!current) return writeJson(response,404,{error:'NOT_FOUND'});
          const { getPolicyEngine } = require('./bootstrap'); const result=await getPolicyEngine(pool).activateBundle({tenantId:auth.tenantId,bundleId:rollback[1],expectedEpoch:current.current_epoch,versions:target.versions,rolloutPercent:target.rollout_percent,rollbackToEpoch:Number(body.epoch),actor:auth.actor}); return writeJson(response,200,result);
        }
        const revoke = pathname.match(/^\/internal\/policy-emergency-deny\/([^/]+)\/revoke$/);
        if (revoke && request.method === 'POST') {
          if (!auth || (!hasRole(auth, 'OWNER') && !hasRole(auth, 'ADMIN'))) return writeJson(response,403,{error:'FORBIDDEN'});
          const result=await pool.query(`UPDATE forge_policy_emergency_denies SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id`,[revoke[1],auth.tenantId]); if(!result.rows[0]) return writeJson(response,404,{error:'NOT_FOUND'}); await pool.query(`INSERT INTO forge_policy_operator_audit(id,tenant_id,actor,action,details) VALUES(gen_random_uuid(),$1,$2,'POLICY_EMERGENCY_REVOKED',$3::jsonb)`,[auth.tenantId,auth.actor,JSON.stringify({denyId:revoke[1]})]); return writeJson(response,200,{id:revoke[1],revoked:true});
        }
        return handlePolicyRequest(request, response, { pool, auth, hasRole });
      };
      return [wrapped, ...current.slice(1)];
    };
    return result;
  };
  extended.__forgePolicyHttpPatched = true;
}
