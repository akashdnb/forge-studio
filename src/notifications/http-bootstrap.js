'use strict';

const { NotificationOrchestrator } = require('./notification-orchestrator');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

function send(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function readJson(req){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1024*1024)throw Object.assign(new Error('Request body exceeds 1 MiB'),{statusCode:413});chunks.push(c);}if(!size)return{};try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Malformed JSON'),{statusCode:400});}}
function tenant(req){const value=req.headers['x-tenant-id'];if(typeof value!=='string'||!value)return null;return value;}
function actor(req){return String(req.headers['x-actor-id']||'api');}

function installNotificationHttp(extended){
  if(!extended||extended.__forgeNotificationsHttpInstalled)return;
  const original=extended.createExtendedApiServer;
  extended.createExtendedApiServer=function createExtendedApiServerWithNotifications(options={}){
    const result=original(options); if(!result?.server?.listeners)return result;
    const base=result.server.listeners('request')[0]; result.server.removeAllListeners('request');
    const service=new NotificationOrchestrator({pool:result.repository?.db?.pool||options.repository?.db?.pool});
    const handler=async(req,res)=>{
      const url=new URL(req.url||'/','http://localhost'); const path=url.pathname.split('/').filter(Boolean); const t=tenant(req); const requestId=req.headers['x-request-id']||randomUUID(); res.setHeader('x-request-id',requestId);
      if(path[0]!=='v1'||!path[1]?.startsWith('notification'))return base(req,res);
      if(!t)return send(res,400,{error:{code:'TENANT_REQUIRED',message:'x-tenant-id is required'},requestId});
      try{
        if(path[1]==='notifications'&&req.method==='POST'&&path.length===2){const body=await readJson(req);const item=await service.enqueue({...body,tenantId:t,createdBy:actor(req)});return send(res,201,{item,requestId});}
        if(path[1]==='notifications'&&req.method==='GET'&&path.length===2){const items=await service.list({tenantId:t,projectId:url.searchParams.get('projectId'),status:url.searchParams.get('status'),limit:Number(url.searchParams.get('limit')||50),offset:Number(url.searchParams.get('offset')||0)});return send(res,200,{items,requestId});}
        if(path[1]==='notifications'&&req.method==='GET'&&path[2]){const item=await service.get(decodeURIComponent(path[2]),t);return item?send(res,200,{item,requestId}):send(res,404,{error:{code:'NOT_FOUND',message:'Notification delivery not found'},requestId});}
        if(path[1]==='notifications'&&path[2]&&path[3]==='cancel'&&req.method==='POST'){const item=await service.cancel(decodeURIComponent(path[2]),{tenantId:t,actor:actor(req),reason:(await readJson(req)).reason||'operator cancelled'});return item?send(res,200,{item,requestId}):send(res,404,{error:{code:'NOT_FOUND',message:'Notification delivery not found'},requestId});}
        if(path[1]==='notification-suppressions'&&req.method==='POST'){const row=await service.suppress({...await readJson(req),tenantId:t},{actor:actor(req)});return send(res,201,{item:row,requestId});}
        if(path[1]==='notifications'&&path[2]==='health'&&req.method==='GET'){await service.pool.query('SELECT 1');return send(res,200,{status:'ok',storage:'postgresql',requestId});}
        return base(req,res);
      }catch(error){return send(res,error.statusCode||422,{error:{code:error.code||'INVALID_REQUEST',message:error.message},requestId});}
    };
    result.server.on('request',handler); return result;
  };
  extended.__forgeNotificationsHttpInstalled=true;
}

try { installNotificationHttp(require('../extended-http-api')); } catch (error) { if (process.env.NODE_ENV==='test') throw error; }
module.exports={installNotificationHttp};
