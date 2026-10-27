'use strict';
const http=require('node:http');
const {URL}=require('node:url');
const {Pool}=require('pg');
const {authenticate,hasRole,applySecurityHeaders}=require('../security/http-security');
const {WorkflowSlaService}=require('./workflow-sla');
let pool=null,sla=null;
if(process.env.DATABASE_URL){pool=new Pool({connectionString:process.env.DATABASE_URL,max:Math.min(5,Number.parseInt(process.env.PG_POOL_MAX||'10',10))});sla=new WorkflowSlaService({pool});}
function json(res,status,body){applySecurityHeaders(res);res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.writeHead(status);res.end(JSON.stringify(body));}
async function body(req){let raw='';for await(const c of req){raw+=c;if(raw.length>1024*1024)throw Object.assign(new Error('request too large'),{statusCode:413});}try{return raw?JSON.parse(raw):{}}catch{throw Object.assign(new Error('invalid JSON'),{statusCode:400})}}
async function handle(req,res){if(!sla)return false;const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/internal/workflow-sla/'))return false;const auth=authenticate(req,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null});if(!auth||!hasRole(auth,'OWNER'))return json(res,403,{error:{code:'FORBIDDEN'}});try{if(url.pathname==='/internal/workflow-sla/diagnostics'&&req.method==='GET')return json(res,200,{items:await sla.diagnostics({limit:Math.min(500,Number(url.searchParams.get('limit')||100))})});const m=/^\/internal\/workflow-sla\/jobs\/([^/]+)$/.exec(url.pathname);if(m&&req.method==='GET')return json(res,200,{item:await sla.inspect(decodeURIComponent(m[1]))});const e=/^\/internal\/workflow-sla\/jobs\/([^/]+)\/extend$/.exec(url.pathname);if(e&&req.method==='POST'){const input=await body(req);return json(res,200,{item:await sla.extend({jobId:decodeURIComponent(e[1]),seconds:Number(input.seconds),actor:auth.actor,reason:input.reason||'operator extension',approvalId:input.approvalId||null})});}if(e&&req.method==='GET')return json(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});return json(res,404,{error:{code:'NOT_FOUND'}});}catch(error){return json(res,error.statusCode||422,{error:{code:error.code||'SLA_ERROR',message:error.message}})}}
const originalEmit=http.Server.prototype.emit;
http.Server.prototype.emit=function forgeSlaEmit(event,...args){if(event==='request'&&args[0]?.url?.startsWith('/internal/workflow-sla/')){handle(args[0],args[1]).catch(error=>json(args[1],500,{error:{code:error.code||'SLA_ERROR'}}));return true}return originalEmit.call(this,event,...args)};
module.exports={sla};
