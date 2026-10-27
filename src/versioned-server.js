const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
require('./diff/http');
const extended = require('./extended-http-api');
const { ProductionSearchService, handleSearchRequest } = require('./search/production-search');
const { authenticate, applySecurityHeaders, safeError, hasRole } = require('./security/http-security');
const { randomUUID } = require('node:crypto');
const { installOperationsControlPlane } = require('./operations/control-plane');
const { installIncidentControlPlane } = require('./incidents/http-extension');
const { installIncidentEventSubscriptionBridge } = require('./incidents/event-subscription-bridge');
const { installIncidentHealthEndpoint } = require('./incidents/health-extension');
const { PersistentProductionRepository } = require('./persistence/production-repository');
const { PostgresRepository } = require('./persistence/postgres-repository');
const { installProvenance } = require('./provenance/install');
const { installProvenanceHttp } = require('./provenance/http');
const { EvidenceService, runEvidenceContext, getEvidenceContext } = require('./evidence/audit-evidence');
const { handleEvidenceRequest } = require('./evidence/http');
const { handleReviewRequest } = require('./review/http');
installProvenance(PersistentProductionRepository);
installProvenanceHttp(extended);
installOperationsControlPlane();
installIncidentControlPlane();
installIncidentEventSubscriptionBridge();
installIncidentHealthEndpoint();

if (!PostgresRepository.prototype.__forgeEvidenceContextPatched) {
  const originalWithTransaction = PostgresRepository.prototype.withTransaction;
  PostgresRepository.prototype.withTransaction = async function withEvidenceContext(operation) {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); const context=getEvidenceContext(); await client.query("SELECT set_config('forge.actor',$1,true), set_config('forge.tenant_id',$2,true), set_config('forge.request_id',$3,true), set_config('forge.causal_event_id',$4,true)",[context.actor,context.tenantId,context.requestId,context.causalEventId]); const result=await operation(client); await client.query('COMMIT'); return result; }
    catch(error){try{await client.query('ROLLBACK');}catch{/* preserve */}throw error;}finally{client.release();}
  };
  PostgresRepository.prototype.__forgeEvidenceContextPatched=true;
  PostgresRepository.prototype.__forgeEvidenceOriginalWithTransaction=originalWithTransaction;
}

const originalReconcile = ProductionSearchService.prototype.reconcile;
ProductionSearchService.prototype.reconcile = async function reconcileWithMissingDetection(args) {
  const result=await originalReconcile.call(this,args); const missing=await this.pool.query({text:`WITH expected AS (
    SELECT p.id project_id,'project' source_type,p.id source_id FROM projects p WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'episode',e.id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'version',v.id FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'artifact',a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT coalesce(j.project_id,e.project_id),'job',j.id FROM forge_jobs j LEFT JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=coalesce(j.project_id,e.project_id) WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'provider_run',r.id FROM provider_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'approval',a.id::text FROM approvals a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'qa',q.id FROM qa_results q JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'publish_run',r.id FROM publish_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT e.project_id,'cost',c.id FROM cost_records c JOIN episodes e ON e.id=c.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
    UNION ALL SELECT coalesce(a.project_id,e.project_id),'audit_event',a.id::text FROM audit_events a LEFT JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=coalesce(a.project_id,e.project_id) WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
  ) SELECT count(*)::int AS count FROM expected x LEFT JOIN forge_search_documents d ON d.project_id=x.project_id AND d.source_type=x.source_type AND d.source_id=x.source_id WHERE d.source_id IS NULL`,values:[args.tenantId,args.projectId||null],statement_timeout:this.statementTimeoutMs});
  const missingCount=Number(missing.rows[0]?.count||0); if(!missingCount)return{...result,missingEntriesDetected:0,rebuildId:null}; const rebuild=await this.createRebuild({tenantId:args.tenantId,actor:args.actor,projectId:args.projectId||null}); return{...result,missingEntriesDetected:missingCount,rebuildId:rebuild.id,rebuildState:rebuild.state};
};

const originalCreateExtendedApiServer=extended.createExtendedApiServer;
extended.createExtendedApiServer=function createExtendedApiServerWithSearchAndEvidence(options={}){
  const result=originalCreateExtendedApiServer(options); if(!result?.server||!options.repository)return result; const originalListeners=result.server.listeners.bind(result.server); const evidence=new EvidenceService({pool:options.repository.db.pool,logger:console});
  result.server.listeners=function listenersWithSearchAndEvidence(eventName){
    const listeners=originalListeners(eventName); if(eventName!=='request'||!listeners.length)return listeners; const baseHandler=listeners[0]; const pool=options.repository.db.pool; const search=new ProductionSearchService({pool});
    const wrapped=async(request,response)=>{const pathname=new URL(request.url||'/','http://localhost').pathname;const requestId=request.headers['x-request-id']||randomUUID();response.setHeader('x-request-id',requestId);applySecurityHeaders(response);const auth=request._auth||authenticate(request,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null});if(!auth)return safeError(response,401,'UNAUTHORIZED',requestId);return runEvidenceContext({actor:auth.actor,tenantId:auth.tenantId,requestId,causalEventId:request.headers['x-causal-event-id']||''},async()=>{if(pathname.startsWith('/v1/evidence/')||pathname.startsWith('/internal/evidence/')){const handled=await handleEvidenceRequest(request,response,{evidence,auth,hasRole,pool,json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));},safeError});if(handled!==false)return handled;}if(pathname.startsWith('/v1/reviews')){const handled=await handleReviewRequest(request,response,{pool,auth,hasRole,requestId,safeError});if(handled!==false)return handled;}if(pathname.startsWith('/v1/search')){try{return handleSearchRequest(request,response,{pool,auth,observability:null,service:search});}catch(error){return safeError(response,error.statusCode||500,error.code||'INTERNAL_ERROR',requestId);}}return baseHandler(request,response);});};
    return[wrapped,...listeners.slice(1)];
  }; return result;
};
installHttpVersioning();
require('./server');
// Loaded after server construction so the idempotency boundary wraps the final evidence-aware transaction implementation.
require('./persistence/idempotency-bootstrap');
