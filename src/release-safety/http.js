'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { authenticate, hasRole } = require('../security/http-security');
const { DeploymentSafetyService, sha256 } = require('./deployment-safety');
const { migrationPreflight, schemaSnapshot } = require('./release-safety');
const { installPublicRunnerEpochGuards } = require('./runtime-guards');
installPublicRunnerEpochGuards();

const originalBuildManifest = DeploymentSafetyService.prototype.buildManifest;
if (!DeploymentSafetyService.prototype.__forgeManifestV2) {
  DeploymentSafetyService.prototype.__forgeManifestV2 = true;
  DeploymentSafetyService.prototype.buildManifest = async function buildManifestV2(input = {}) {
    const manifest = await originalBuildManifest.call(this, input);
    const migration = await migrationPreflight({ pool: this.pool, migrationsDir: this.migrationsDir });
    const schema = await schemaSnapshot(this.pool);
    manifest.migrationManifest = migration.audit.items.map(m => ({ name: m.name, checksum: m.checksum, number: Number(String(m.name).split('_', 1)[0]), unsafe: Boolean(m.unsafe), destructive: Boolean(m.destructive) }));
    manifest.workerVersions = input.workerVersions || {};
    manifest.protocolVersions = input.protocolVersions || { publicRunner: 'forge-public-runner-v1', callbacks: '1' };
    manifest.requiredProtocolVersion = input.requiredProtocolVersion || '1';
    manifest.configSnapshotHash = input.configSnapshotHash || null;
    manifest.schemaSnapshotHash = schema.hash;
    manifest.rolloutPolicy = input.rolloutPolicy || { allowPreviousEpoch: false, maxUnavailableWorkers: 0, requireDrainForUnsafeMigration: true };
    manifest.healthPolicy = input.healthPolicy || { requireSchemaMatch: true, requireWorkerAdmission: true, maxStaleRunnerExecutions: 0 };
    manifest.migrationSetHash = sha256(manifest.migrationManifest);
    manifest.manifestHash = sha256(manifest);
    return manifest;
  };
}

function reply(res, status, body, requestId) { if (res.headersSent) return; res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-request-id',requestId); res.writeHead(status); res.end(JSON.stringify(body)); }
async function body(req) { const chunks=[]; let size=0; for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw Object.assign(new Error('Request body exceeds limit'),{statusCode:413,code:'PAYLOAD_TOO_LARGE'});chunks.push(chunk)} if(!chunks.length)return{}; try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('Malformed JSON request body'),{statusCode:400,code:'VALIDATION_ERROR'})} }

function installReleaseDeploymentSafety({ pg=null, authSecret=process.env.FORGE_AUTH_SIGNING_SECRET||null, apiToken=process.env.API_BEARER_TOKEN||null, staticActor=process.env.FORGE_STATIC_ACTOR_ID||null, staticTenant=process.env.FORGE_STATIC_TENANT_ID||null, logger=console }={}) {
  if (http.Server.prototype.__forgeReleaseDeploymentSafety) return;
  http.Server.prototype.__forgeReleaseDeploymentSafety=true;
  const originalEmit=http.Server.prototype.emit;
  http.Server.prototype.emit=function(event,req,res){
    if(event!=='request') return originalEmit.apply(this,arguments);
    const url=new URL(req.url||'/','http://localhost');
    if(!/^\/v1\/ops\/releases(?:\/|$)/.test(url.pathname)) return originalEmit.apply(this,arguments);
    void handle(req,res,url).catch(error=>{const requestId=req.headers['x-request-id']||randomUUID();logger.error?.({event:'release.deployment_safety_failed',requestId,code:error.code,message:error.message});reply(res,error.statusCode||500,{error:{code:error.code||'INTERNAL_ERROR',message:String(error.message||'Request failed').slice(0,300)},requestId},requestId)});
    return true;
  };
  let pool=pg;
  async function db(){if(pool)return pool;if(!process.env.DATABASE_URL)return null;const{Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});return pool}
  async function handle(req,res,url){
    const requestId=req.headers['x-request-id']||randomUUID();
    const p=await db(); if(!p)return reply(res,503,{error:{code:'PERSISTENCE_UNAVAILABLE'},requestId},requestId);
    const auth=authenticate(req,{apiToken,authSecret,staticActor,staticTenant}); if(!auth)return reply(res,401,{error:{code:'UNAUTHORIZED'},requestId},requestId);
    if(!hasRole(auth,'OWNER'))return reply(res,403,{error:{code:'FORBIDDEN'},requestId},requestId);
    const service=new DeploymentSafetyService({pool:p,logger});
    const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(req.method==='GET'&&parts[2]==='health')return reply(res,200,await service.health(url.searchParams.get('releaseId')),requestId);
    if(req.method==='GET'&&parts[2]==='diagnostics')return reply(res,200,await service.diagnostics(),requestId);
    if(req.method==='GET'&&parts[2]==='metrics'){
      const [state,checks,jobs,workers,executions]=await Promise.all([
        p.query('SELECT state,epoch FROM forge_release_state WHERE id=true'),
        p.query("SELECT status,count(*)::int AS count FROM forge_release_deployment_checks GROUP BY status ORDER BY status"),
        p.query("SELECT status,count(*)::int AS count FROM forge_jobs WHERE status IN ('QUEUED','RUNNING','FAILED') GROUP BY status ORDER BY status"),
        p.query("SELECT status,count(*)::int AS count FROM forge_worker_fences GROUP BY status ORDER BY status"),
        p.query("SELECT status,count(*)::int AS count FROM forge_execution_runs WHERE backend='public-github-actions' GROUP BY status ORDER BY status")
      ]);
      const body={activeReleaseState:state.rows[0]||null,deploymentChecks:checks.rows,jobs:jobs.rows,workers:workers.rows,publicRunnerExecutions:executions.rows};
      return reply(res,200,body,requestId);
    }
    if(parts[2]&&parts[2]!=='health'&&parts[2]!=='diagnostics'&&parts[2]!=='metrics'){
      const releaseId=parts[2];
      if(req.method==='GET'&&parts.length===4&&parts[3]==='health')return reply(res,200,await service.health(releaseId),requestId);
      if(req.method==='POST'&&parts.length===4&&parts[3]==='preflight')return reply(res,200,await service.preflight(releaseId,{},auth.actor),requestId);
      if(req.method==='POST'&&parts.length===4&&parts[3]==='approve')return reply(res,200,await service.approve(releaseId,auth.actor,await body(req)),requestId);
      if(req.method==='POST'&&parts.length===4&&parts[3]==='activate')return reply(res,202,await service.activate(releaseId,auth.actor),requestId);
      if(req.method==='POST'&&parts.length===4&&parts[3]==='health')return reply(res,200,await service.completeHealth(releaseId,auth.actor),requestId);
      if(req.method==='POST'&&parts.length===4&&parts[3]==='rollback')return reply(res,200,await service.rollback(releaseId,auth.actor,await body(req)),requestId);
    }
    if(req.method==='POST'&&parts.length===3&&parts[2]==='plan'){const input=await body(req);const manifest=await service.persistManifest({...input,releaseId:input.releaseId||randomUUID()},auth.actor);return reply(res,201,{item:manifest},requestId)}
    return reply(res,404,{error:{code:'NOT_FOUND'},requestId},requestId);
  }
}
module.exports={installReleaseDeploymentSafety};
