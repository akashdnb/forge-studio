const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const state = http[Symbol.for('forge.clientContracts')];
if (!state || !state.pool || http.__forgeClientContractExtensionsInstalled) return;
const { pool, store, generateContract } = state;
const json = (response, status, body) => { if (response.headersSent) return false; response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); return true; };
const authFor = (request) => { try { const { authenticate, hasRole } = require('../security/http-security'); const auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null }); return auth && hasRole(auth, 'OWNER') ? auth : null; } catch { return null; } };
const originalCreateServer = http.createServer;
http.createServer = function clientContractExtensionServer(requestListener) {
  const server = originalCreateServer.call(this);
  const originalOn = server.on.bind(server); const originalAddListener = server.addListener.bind(server);
  const wrap = (listener) => async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/internal/client-contracts/')) return listener(request, response);
    const auth = authFor(request); if (!auth) return json(response, 403, { error: { code: 'FORBIDDEN' } });
    if (request.method === 'POST' && pathname === '/internal/client-contracts/rollback') {
      let raw=''; for await (const chunk of request) raw += chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(response,400,{error:{code:'MALFORMED_JSON'}}); }
      const client=await pool.connect(); try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['forge-client-contract:rollback']); const target=await client.query("SELECT * FROM forge_client_contract_revisions WHERE id=$1 AND status IN ('PUBLISHED','SUPERSEDED','ROLLED_BACK') FOR UPDATE",[body.revisionId]); if(!target.rows[0]){await client.query('ROLLBACK');return json(response,404,{error:{code:'REVISION_NOT_FOUND'}});} await client.query("UPDATE forge_client_contract_revisions SET status='ROLLED_BACK' WHERE status='PUBLISHED'"); await client.query("UPDATE forge_client_contract_revisions SET status='PUBLISHED',published_at=now(),published_by=$2 WHERE id=$1",[body.revisionId,auth.actor]); await client.query('INSERT INTO forge_client_contract_audit(revision_id,action,actor_id,tenant_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',[body.revisionId,'ROLLED_BACK',auth.actor,auth.tenantId||null,JSON.stringify({reason:body.reason||null})]); await client.query('COMMIT'); return json(response,200,{item:{revisionId:body.revisionId,status:'PUBLISHED',action:'ROLLED_BACK'}}); } catch(error){try{await client.query('ROLLBACK')}catch{} throw error;} finally{client.release();}
    }
    if (request.method === 'POST' && pathname === '/internal/client-contracts/replay') {
      let raw=''; for await (const chunk of request) raw += chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(response,400,{error:{code:'MALFORMED_JSON'}}); }
      const result=await pool.query("SELECT a.content,r.api_version FROM forge_client_contract_artifacts a JOIN forge_client_contract_revisions r ON r.id=a.revision_id WHERE a.revision_id=$1 AND a.artifact_kind='openapi-json'",[body.revisionId]); if(!result.rows[0])return json(response,404,{error:{code:'REVISION_ARTIFACT_NOT_FOUND'}}); const generated=generateContract({document:JSON.parse(result.rows[0].content),apiVersion:String(result.rows[0].api_version||'v2').replace(/^v/,'')}); const published=await store.publish({generated,apiVersion:String(result.rows[0].api_version||'v2').replace(/^v/,''),actor:auth.actor,tenantId:auth.tenantId,sourceCommit:body.sourceCommit||null,decisionId:body.decisionId||null}); return json(response,201,{item:published});
    }
    if (request.method === 'GET' && pathname === '/internal/client-contracts/compatibility-report') {
      const latest=await store.latest('v2'); const consumers=await pool.query('SELECT * FROM forge_client_contract_consumers ORDER BY last_seen_at DESC LIMIT 500'); return json(response,200,{contract:latest,items:consumers.rows.map((consumer)=>({...consumer,compatible:!consumer.declared_contract_fingerprint||!latest||consumer.declared_contract_fingerprint===latest.contract_fingerprint}))});
    }
    return listener(request,response);
  };
  server.on=(event,listener)=>originalOn(event,event==='request'?wrap(listener):listener);
  server.addListener=(event,listener)=>originalAddListener(event,event==='request'?wrap(listener):listener);
  if(requestListener)server.on('request',requestListener);
  return server;
};
http.__forgeClientContractExtensionsInstalled=true;
