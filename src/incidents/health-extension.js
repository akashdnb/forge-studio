'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { authenticate, hasRole } = require('../security/http-security');
const { IncidentManager } = require('./incident-manager');
function installIncidentHealthEndpoint({ pg = null, logger = console, apiToken = process.env.API_BEARER_TOKEN || null, authSecret = process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor = process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant = process.env.FORGE_STATIC_TENANT_ID || null } = {}) {
  if (http.Server.prototype.__forgeIncidentHealth) return;
  http.Server.prototype.__forgeIncidentHealth = true;
  const originalEmit = http.Server.prototype.emit;
  let pool = pg;
  async function db(){if(pool)return pool;if(!process.env.DATABASE_URL)return null;const{Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});return pool}
  http.Server.prototype.emit=function emit(event,req,res){if(event!=='request')return originalEmit.apply(this,arguments);const url=new URL(req.url||'/','http://localhost');if(url.pathname!=='/v1/ops/incident-health')return originalEmit.apply(this,arguments);void handle(req,res).catch(error=>{const requestId=req.headers['x-request-id']||randomUUID();logger.error?.({event:'incident.health_failed',requestId,message:error.message});if(!res.headersSent){res.setHeader('content-type','application/json');res.setHeader('x-request-id',requestId);res.writeHead(500);res.end(JSON.stringify({ok:false,error:{code:'HEALTH_QUERY_FAILED'},requestId}))}});return true};
  async function handle(req,res){const requestId=req.headers['x-request-id']||randomUUID();const p=await db();if(!p)return reply(503,{ok:false,error:{code:'PERSISTENCE_UNAVAILABLE'},requestId},res,requestId);const auth=authenticate(req,{apiToken,authSecret,staticActor,staticTenant});if(!auth||!hasRole(auth,'OWNER'))return reply(auth?403:401,{ok:false,error:{code:auth?'FORBIDDEN':'UNAUTHORIZED'},requestId},res,requestId);const manager=new IncidentManager({pool:p,logger});const metrics=await manager.metrics({tenantId:auth.tenantId});const pending=Number(metrics.notifications?.pending||0);const dead=Number(metrics.notifications?.dead_letter||0);const critical=Number((metrics.active||[]).find(row=>row.severity==='CRITICAL')?.count||0);return reply(dead>0||critical>0?200:200,{ok:true,status:dead>0?'DEGRADED':critical>0?'ATTENTION':'READY',metrics,requestId},res,requestId)}
  function reply(status,body,res,requestId){res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-request-id',requestId);res.writeHead(status);res.end(JSON.stringify(body))}
}
module.exports={installIncidentHealthEndpoint};
