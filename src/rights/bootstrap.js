'use strict';

const { RightsComplianceService } = require('./service');
const { PublishService } = require('../publishing/publish-service');
const { authenticate, applySecurityHeaders, safeError, hasRole } = require('../security/http-security');
const { randomUUID } = require('node:crypto');

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body='';
    request.on('data', chunk => { body += chunk; if (body.length > 1024*1024) reject(Object.assign(new Error('request body too large'),{statusCode:413,code:'PAYLOAD_TOO_LARGE'})); });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('invalid json'),{statusCode:400,code:'INVALID_JSON'})); } });
    request.on('error', reject);
  });
}
function send(response,status,body,requestId) { applySecurityHeaders(response); response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestId}); response.end(JSON.stringify(body)); }

if (!PublishService.prototype.__forgeRightsPatched) {
  const originalPublish = PublishService.prototype.publish;
  PublishService.prototype.publish = async function publishWithRightsCompliance(args) {
    const runId=args?.runId;
    if (!runId) return originalPublish.call(this,args);
    const run=(await this.pool.query(`SELECT p.id,p.destination,p.tenant_id,e.project_id,pr.tenant_id AS project_tenant_id FROM publish_runs p JOIN episodes e ON e.id=p.episode_id JOIN projects pr ON pr.id=e.project_id WHERE p.id=$1`,[runId])).rows[0];
    if (!run) return originalPublish.call(this,args);
    const rights=new RightsComplianceService({pool:this.pool,now:this.now,logger:this.logger});
    const actor=args.actor||'worker';
    await rights.snapshotPublishFromRun({tenantId:run.tenant_id,projectId:run.project_id,runId,actor});
    return originalPublish.call(this,args);
  };
  PublishService.prototype.__forgeRightsPatched=true;
}

try {
  const extended = require('../extended-http-api');
  const original = extended.createExtendedApiServer;
  if (!extended.__forgeRightsHttpPatched) {
    extended.createExtendedApiServer = function createExtendedApiServerWithRights(options={}) {
      const result=original(options); if(!result?.server||!options.repository)return result;
      const listeners=result.server.listeners.bind(result.server);
      result.server.listeners=function rightsListeners(eventName){
        const base=listeners(eventName); if(eventName!=='request'||!base.length)return base;
        const baseHandler=base[0]; const pool=options.repository.db.pool;
        const wrapped=async(request,response)=>{
          const pathname=new URL(request.url||'/','http://localhost').pathname;
          if(!pathname.startsWith('/v1/rights')) return baseHandler(request,response);
          const requestId=request.headers['x-request-id']||randomUUID();
          const auth=authenticate(request,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null});
          if(!auth)return safeError(response,401,'UNAUTHORIZED',requestId);
          try {
            const rights=new RightsComplianceService({pool}); const idMatch=/^\/v1\/rights\/([^/]+)$/.exec(pathname); const body=request.method==='GET'?{}:await readJson(request);
            const projectId=body.projectId||new URL(request.url,'http://localhost').searchParams.get('projectId');
            if(!projectId)return safeError(response,400,'PROJECT_REQUIRED',requestId);
            if(request.method==='GET'&&pathname==='/v1/rights') return send(response,200,{items:await rights.list({tenantId:auth.tenantId,projectId,targetId:new URL(request.url,'http://localhost').searchParams.get('targetId')})},requestId);
            if(!hasRole(auth,'OWNER'))return safeError(response,403,'FORBIDDEN',requestId);
            if(request.method==='POST'&&pathname==='/v1/rights') return send(response,201,await rights.create({tenantId:auth.tenantId,projectId,actor:auth.actor,targetType:body.targetType,targetId:body.targetId,rights:body.rights,evidence:body.evidence,externalFingerprint:body.externalFingerprint}),requestId);
            if(idMatch){const recordId=decodeURIComponent(idMatch[1]);
              if(request.method==='PUT') return send(response,200,await rights.replace({tenantId:auth.tenantId,projectId,recordId,expectedVersionNo:body.expectedVersionNo,actor:auth.actor,rights:body.rights,evidence:body.evidence,action:body.action==='RENEW'?'RENEW':'REPLACE'}),requestId);
              if(request.method==='POST'&&body.action) return send(response,200,await rights.setReviewState({tenantId:auth.tenantId,projectId,recordId,actor:auth.actor,state:body.action,evidence:body.evidence}),requestId);
            }
            const overrideMatch=/^\/v1\/rights\/snapshots\/([^/]+)\/override$/.exec(pathname);
            if(overrideMatch&&request.method==='POST'){
              const snapshotId=decodeURIComponent(overrideMatch[1]);
              const snap=(await pool.query('SELECT * FROM forge_rights_snapshots WHERE id=$1 AND tenant_id=$2 AND project_id=$3',[snapshotId,auth.tenantId,projectId])).rows[0];
              if(!snap)return safeError(response,404,'NOT_FOUND',requestId);
              if(!body.reason||!body.evidence||!body.expiresAt)return safeError(response,400,'OVERRIDE_EVIDENCE_REQUIRED',requestId);
              const result=await rights.snapshotForExecution({tenantId:auth.tenantId,projectId,episodeId:snap.episode_id,executionType:snap.execution_type,executionId:snap.execution_id,rootArtifactId:snap.render_artifact_id||snap.package_artifact_id,rootVersionId:snap.render_version_id||snap.package_version_id,destination:snap.destination||'package',territory:snap.territory||'global',use:snap.execution_type==='PUBLISH'?'PUBLISH':'PACKAGE',override:{reason:body.reason,evidence:body.evidence,approvedBy:auth.actor,expiresAt:body.expiresAt},packageArtifactId:snap.package_artifact_id,packageVersionId:snap.package_version_id});
              if(result.decision!=='OVERRIDE')return safeError(response,409,'RIGHTS_OVERRIDE_NOT_REQUIRED',requestId);
              await pool.query('INSERT INTO forge_rights_overrides(id,tenant_id,project_id,episode_id,rights_snapshot_id,destination,reason,evidence,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',[`override:${randomUUID()}`,auth.tenantId,projectId,snap.episode_id,result.snapshotId,snap.destination||'package',body.reason,JSON.stringify(body.evidence),auth.actor,body.expiresAt]);
              if(snap.execution_type==='PUBLISH')await pool.query('UPDATE publish_runs SET rights_snapshot_id=$1 WHERE id=$2',[result.snapshotId,snap.execution_id]);
              return send(response,200,result,requestId);
            }
            return safeError(response,404,'NOT_FOUND',requestId);
          }catch(error){return safeError(response,error.statusCode||500,error.code||'INTERNAL_ERROR',requestId);}
        };
        return [wrapped,...base.slice(1)];
      };
      return result;
    };
    extended.__forgeRightsHttpPatched=true;
  }
} catch { /* HTTP module is loaded only in API processes. */ }

module.exports={};
