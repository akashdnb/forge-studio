const http = require('node:http');
const { URL } = require('node:url');
const state = http[Symbol.for('forge.clientContracts')];
if (state && state.pool && !http.__forgeClientContractImportInstalled) {
  const { store, generateContract } = state;
  const json=(res,status,body)=>{if(res.headersSent)return false;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));return true;};
  const authFor=(req)=>{try{const{authenticate,hasRole}=require('../security/http-security');const a=req._auth||authenticate(req,{apiToken:process.env.API_BEARER_TOKEN||null,authSecret:process.env.FORGE_AUTH_SIGNING_SECRET||null,staticActor:process.env.FORGE_STATIC_ACTOR_ID||null,staticTenant:process.env.FORGE_STATIC_TENANT_ID||null});return a&&hasRole(a,'OWNER')?a:null;}catch{return null;}};
  const originalCreateServer=http.createServer;
  http.createServer=function clientContractImportServer(requestListener){const server=originalCreateServer.call(this),on=server.on.bind(server),add=server.addListener.bind(server);const wrap=listener=>async(req,res)=>{const path=new URL(req.url||'/','http://localhost').pathname;if(req.method!=='POST'||path!=='/internal/client-contracts/import')return listener(req,res);const auth=authFor(req);if(!auth)return json(res,403,{error:{code:'FORBIDDEN'}});let raw='';for await(const ch of req)raw+=ch;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:{code:'MALFORMED_JSON'}})}if(!body.document||typeof body.document!=='object')return json(res,400,{error:{code:'CONTRACT_DOCUMENT_REQUIRED'}});const apiVersion=String(body.apiVersion||'2').replace(/^v/,'');const generated=generateContract({document:body.document,apiVersion});const result=await store.publish({generated,apiVersion,actor:auth.actor,tenantId:auth.tenantId,sourceCommit:body.sourceCommit||'import',decisionId:body.decisionId||null});return json(res,201,{item:result});};server.on=(e,l)=>on(e,e==='request'?wrap(l):l);server.addListener=(e,l)=>add(e,e==='request'?wrap(l):l);if(requestListener)server.on('request',requestListener);return server;};
  http.__forgeClientContractImportInstalled=true;
}
