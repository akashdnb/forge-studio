'use strict';
const http=require('node:http');
const {URL}=require('node:url');
const {Pool}=require('pg');
const {ProductionUsageLedger}=require('./production-ledger');
const {BillingReconciliation}=require('./billing-reconciliation');

if(process.env.DATABASE_URL&&process.env.FORGE_BILLING_OPERATOR_PORT){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
 const ledger=new ProductionUsageLedger({pool});
 const reconciliation=new BillingReconciliation({pool});
 const token=process.env.FORGE_USAGE_OPERATOR_TOKEN;
 const auth=req=>{const got=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');return Boolean(token&&got&&got.length===token.length&&require('node:crypto').timingSafeEqual(Buffer.from(got),Buffer.from(token)))};
 const json=async req=>{const chunks=[];for await(const c of req)chunks.push(c);return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{}};
 const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
 const server=http.createServer(async(req,res)=>{try{if(!auth(req))return send(res,401,{error:{code:'UNAUTHORIZED'}});const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),p=u.pathname.split('/').filter(Boolean),tenant=req.headers['x-tenant-id'];if(!tenant)return send(res,400,{error:{code:'TENANT_REQUIRED'}});
   if(req.method==='GET'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='health'){const integrity=await ledger.verifyTenant(tenant);const active=(await pool.query(`SELECT count(*)::int count FROM usage_billing_reservations WHERE tenant_id=$1 AND status='HELD'`,[tenant])).rows[0].count;return send(res,integrity.valid?200:503,{status:integrity.valid?'ok':'degraded',tenantId:tenant,integrity,activeReservations:active,checkedAt:new Date().toISOString()})}
   if(req.method==='GET'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='reservations')return send(res,200,{items:(await pool.query(`SELECT * FROM usage_billing_reservations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`,[tenant])).rows});
   if(req.method==='GET'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='usage')return send(res,200,{items:await ledger.inspect({tenantId:tenant,projectId:u.searchParams.get('projectId'),dimension:u.searchParams.get('dimension'),limit:u.searchParams.get('limit'),offset:u.searchParams.get('offset')})});
   if(req.method==='GET'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='report')return send(res,200,await reconciliation.report({tenantId:tenant,from:u.searchParams.get('from'),to:u.searchParams.get('to'),currency:u.searchParams.get('currency')}));
   if(req.method==='POST'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='evidence'){const body=await json(req);return send(res,201,await reconciliation.evidence({...body,tenantId:tenant}))}
   if(req.method==='POST'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='reconcile'){const body=await json(req);return send(res,200,await reconciliation.reconcile({tenantId:tenant,windowStart:body.windowStart,windowEnd:body.windowEnd,source:body.source||'evidence',limit:body.limit||500}))}
   if(req.method==='GET'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='discrepancies')return send(res,200,{items:(await pool.query(`SELECT * FROM usage_billing_discrepancies WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`,[tenant])).rows});
   if(req.method==='POST'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='discrepancies'&&p[3]){const body=await json(req);return send(res,200,await reconciliation.discrepancy({tenantId:tenant,discrepancyId:p[3],status:body.status,actor:req.headers['x-actor-id']||'operator',reason:body.reason||''}))}
   if(req.method==='POST'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='corrections'){const body=await json(req);const requested=await ledger.requestAdjustment({...body,tenantId:tenant,requestedBy:req.headers['x-actor-id']||'operator'});return send(res,201,requested)}
   if(req.method==='POST'&&p[0]==='v1'&&p[1]==='billing'&&p[2]==='corrections'&&p[3]&&p[4]==='decision'){const body=await json(req);return send(res,200,await ledger.decideAdjustment({adjustmentId:p[3],approve:body.approve===true,actor:req.headers['x-actor-id']||'operator',note:body.note||''}))}
   return send(res,404,{error:{code:'NOT_FOUND'}});
 }catch(error){console.error(JSON.stringify({event:'billing.operator.error',code:error.code,message:error.message}));return send(res,error.statusCode||400,{error:{code:error.code||'INVALID_REQUEST',message:error.message}})}});
 server.listen(Number(process.env.FORGE_BILLING_OPERATOR_PORT),process.env.FORGE_BILLING_OPERATOR_HOST||'127.0.0.1');
}
