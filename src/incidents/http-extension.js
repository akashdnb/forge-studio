'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { authenticate, hasRole } = require('../security/http-security');
const { IncidentManager } = require('./incident-manager');

function reply(res, status, body, requestId) {
  if (res.headersSent) return;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-request-id', requestId);
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw Object.assign(new Error('Request body exceeds limit'), { code:'PAYLOAD_TOO_LARGE', statusCode:413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Malformed JSON'), { code:'VALIDATION_ERROR', statusCode:400 }); }
}
function int(value, fallback, max = 100) { const n = value == null ? fallback : Number(value); if (!Number.isInteger(n) || n < 0 || n > max) throw Object.assign(new Error(`value must be an integer between 0 and ${max}`), {code:'VALIDATION_ERROR',statusCode:400}); return n; }

function installIncidentControlPlane({ pg = null, logger = console, apiToken = process.env.API_BEARER_TOKEN || null, authSecret = process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor = process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant = process.env.FORGE_STATIC_TENANT_ID || null } = {}) {
  if (http.Server.prototype.__forgeIncidentControlPlane) return;
  http.Server.prototype.__forgeIncidentControlPlane = true;
  const originalEmit = http.Server.prototype.emit;
  let pool = pg;
  async function db() { if (pool) return pool; if (!process.env.DATABASE_URL) return null; const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }); return pool; }
  http.Server.prototype.emit = function emit(event, req, res) {
    if (event !== 'request') return originalEmit.apply(this, arguments);
    const url = new URL(req.url || '/', 'http://localhost');
    if (!/^\/v1\/ops\/(incidents|incident-rules|maintenance-windows|incident-metrics)(\/|$)/.test(url.pathname)) return originalEmit.apply(this, arguments);
    void handle(req,res).catch(error => { const requestId=req.headers['x-request-id']||randomUUID(); logger.error?.({event:'incident.api_failed',requestId,code:error.code,message:error.message}); reply(res,error.statusCode||500,{error:{code:error.code||'INTERNAL_ERROR',message:String(error.message).slice(0,300)},requestId},requestId); });
    return true;
  };
  async function handle(req,res) {
    const requestId=req.headers['x-request-id']||randomUUID(); const p=await db(); if(!p)return reply(res,503,{error:{code:'PERSISTENCE_UNAVAILABLE'},requestId},requestId);
    const auth=authenticate(req,{apiToken,authSecret,staticActor,staticTenant}); if(!auth)return reply(res,401,{error:{code:'UNAUTHORIZED'},requestId},requestId); if(!hasRole(auth,'OWNER'))return reply(res,403,{error:{code:'FORBIDDEN'},requestId},requestId);
    const manager=new IncidentManager({pool:p,logger}); const url=new URL(req.url||'/','http://localhost'); const parts=url.pathname.replace(/^\/v1\/ops\//,'').split('/').filter(Boolean).map(decodeURIComponent);
    if(req.method==='GET'&&parts[0]==='incidents'&&!parts[1]) return reply(res,200,{items:await manager.list({tenantId:auth.tenantId,projectId:url.searchParams.get('projectId'),status:url.searchParams.get('status'),severity:url.searchParams.get('severity'),limit:int(url.searchParams.get('limit'),50),offset:int(url.searchParams.get('offset'),0,1000000)}),requestId},requestId);
    if(req.method==='GET'&&parts[0]==='incidents'&&parts[1]) { const item=await manager.get(auth.tenantId,parts[1]); return reply(res,item?200:404,item?{item,requestId}:{error:{code:'NOT_FOUND'},requestId},requestId); }
    if(req.method==='POST'&&parts[0]==='incidents'&&parts[1]&&parts[2]) {
      const body=await readBody(req); const action=parts[2].toUpperCase();
      const item=await manager.transition({tenantId:auth.tenantId,incidentId:parts[1],actorId:auth.actor,action,reason:body.reason,ownerId:body.ownerId||null,resolutionEvidence:body.resolutionEvidence||body.evidence||{},idempotencyKey:body.idempotencyKey||null});
      return reply(res,200,{item,requestId},requestId);
    }
    if(req.method==='GET'&&parts[0]==='incident-rules') { const rows=await p.query('SELECT id,tenant_id,rule_key,enabled,severity,threshold_seconds,cooldown_seconds,max_events_per_window,aggregation_window_seconds,escalation_policy,config,updated_at FROM incident_rules WHERE tenant_id=$1 ORDER BY rule_key',[auth.tenantId]); return reply(res,200,{items:rows.rows,requestId},requestId); }
    if(req.method==='PATCH'&&parts[0]==='incident-rules'&&parts[1]) {
      const b=await readBody(req); const allowed=['enabled','severity','thresholdSeconds','cooldownSeconds','maxEventsPerWindow','aggregationWindowSeconds','escalationPolicy','config'];
      const r=await p.query(`UPDATE incident_rules SET enabled=COALESCE($2,enabled),severity=COALESCE($3,severity),threshold_seconds=COALESCE($4,threshold_seconds),cooldown_seconds=COALESCE($5,cooldown_seconds),max_events_per_window=COALESCE($6,max_events_per_window),aggregation_window_seconds=COALESCE($7,aggregation_window_seconds),escalation_policy=COALESCE($8,escalation_policy),config=COALESCE($9,config),updated_at=now() WHERE tenant_id=$1 AND id=$10 RETURNING id,rule_key,enabled,severity,threshold_seconds,cooldown_seconds,max_events_per_window,aggregation_window_seconds,escalation_policy,config,updated_at`,[auth.tenantId,b.enabled,b.severity,b.thresholdSeconds,b.cooldownSeconds,b.maxEventsPerWindow,b.aggregationWindowSeconds,b.escalationPolicy?JSON.stringify(b.escalationPolicy):null,b.config?JSON.stringify(b.config):null,parts[1]]); if(!r.rows[0])return reply(res,404,{error:{code:'NOT_FOUND'},requestId},requestId); await p.query(`INSERT INTO security_audit_events(tenant_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,'INCIDENT_RULE_UPDATED','incident_rule',$3,'ALLOWED',$4::jsonb)`,[auth.tenantId,auth.actor,parts[1],JSON.stringify({fields:allowed.filter(k=>b[k]!==undefined)})]); return reply(res,200,{item:r.rows[0],requestId},requestId);
    }
    if(req.method==='POST'&&parts[0]==='maintenance-windows') { const b=await readBody(req); if(!b.startsAt||!b.endsAt||new Date(b.endsAt)<=new Date(b.startsAt)||!b.reason||String(b.reason).trim().length<8) throw Object.assign(new Error('Valid startsAt, endsAt and reason are required'),{code:'VALIDATION_ERROR',statusCode:400}); if(b.projectId){const project=(await p.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2',[b.projectId,auth.tenantId])).rows[0];if(!project)throw Object.assign(new Error('Project not found'),{code:'NOT_FOUND',statusCode:404});} const id=`mw_${randomUUID()}`; const row=(await p.query(`INSERT INTO incident_maintenance_windows(id,tenant_id,project_id,rule_key,starts_at,ends_at,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,auth.tenantId,b.projectId||null,b.ruleKey||null,b.startsAt,b.endsAt,String(b.reason).slice(0,1000),auth.actor])).rows[0]; return reply(res,201,{item:row,requestId},requestId); }
    if(req.method==='GET'&&parts[0]==='maintenance-windows') { const rows=await p.query('SELECT * FROM incident_maintenance_windows WHERE tenant_id=$1 ORDER BY starts_at DESC LIMIT $2',[auth.tenantId,int(url.searchParams.get('limit'),100)]); return reply(res,200,{items:rows.rows,requestId},requestId); }
    if(req.method==='DELETE'&&parts[0]==='maintenance-windows'&&parts[1]) { const r=await p.query('DELETE FROM incident_maintenance_windows WHERE tenant_id=$1 AND id=$2 RETURNING id',[auth.tenantId,parts[1]]); return reply(res,r.rows[0]?204:404,r.rows[0]?null:{error:{code:'NOT_FOUND'},requestId},requestId); }
    if(req.method==='GET'&&parts[0]==='incident-metrics') return reply(res,200,{item:await manager.metrics({tenantId:auth.tenantId}),requestId},requestId);
    return originalEmit.call(this,req,res);
  }
}
module.exports={installIncidentControlPlane};
