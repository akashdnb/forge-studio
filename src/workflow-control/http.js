'use strict';
const { WorkflowControlService } = require('./service');
const send=(res,status,body)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
const json=async req=>{const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
function installWorkflowControlHttp(extended){if(extended.__forgeWorkflowControlHttp)return;extended.__forgeWorkflowControlHttp=true;const original=extended.createExtendedApiServer;extended.createExtendedApiServer=function(options={}){const r=original(options);if(!r?.server||!options.repository)return r;const base=r.server.listeners('request')[0];r.server.removeAllListeners('request');const pool=options.repository.db.pool,svc=new WorkflowControlService({pool});r.server.on('request',async(req,res)=>{const p=new URL(req.url||'/','http://x').pathname.split('/').filter(Boolean);if(p[0]!=='v1')return base(req,res);const actor=req.headers['x-actor-id']||'api',tenantId=req.headers['x-tenant-id']||actor,idempotencyKey=req.headers['idempotency-key'];try{
 if(req.method==='GET'&&p[1]==='workflow-controls'&&p[2]==='health'){const rows=(await pool.query(`SELECT state,COUNT(*)::int count FROM forge_workflow_controls WHERE tenant_id=$1 GROUP BY state ORDER BY state`,[tenantId])).rows;const checkpoints=(await pool.query(`SELECT validity,COUNT(*)::int count FROM forge_workflow_checkpoints WHERE tenant_id=$1 GROUP BY validity ORDER BY validity`,[tenantId])).rows;return send(res,200,{ok:true,tenantId,states:rows,checkpoints,diagnostics:{fencingEnabled:true,checkpointSchemaVersion:2,safeReentryEnabled:true}});}
 if(p[1]!=='execution-plans'||!p[2])return base(req,res);const planId=p[2];
 if(req.method==='GET'&&p.length===3)return send(res,200,{item:await svc.get(planId,tenantId)});
 if(req.method==='GET'&&p[3]==='events')return send(res,200,{items:(await pool.query(`SELECT * FROM forge_workflow_control_events WHERE plan_id=$1 AND tenant_id=$2 ORDER BY created_at,id`,[planId,tenantId])).rows});
 if(req.method==='GET'&&p[3]==='checkpoints'&&p.length===4)return send(res,200,{items:(await pool.query(`SELECT * FROM forge_workflow_checkpoints WHERE plan_id=$1 AND tenant_id=$2 ORDER BY checkpoint_version`,[planId,tenantId])).rows});
 if(req.method==='GET'&&p[3]==='checkpoints'&&p[5]==='diagnostics')return send(res,200,{items:(await pool.query(`SELECT * FROM forge_workflow_checkpoint_diagnostics WHERE checkpoint_id=$1 AND tenant_id=$2 ORDER BY created_at,id`,[p[4],tenantId])).rows});
 if(req.method!=='POST')return base(req,res);const b=await json(req);const key=idempotencyKey||b.idempotencyKey;
 if(p[3]==='pause')return send(res,200,{item:await svc.pause({planId,tenantId,actor,reason:b.reason,idempotencyKey:key})});
 if(p[3]==='resume')return send(res,200,{item:await svc.resume({planId,tenantId,actor,idempotencyKey:key})});
 if(p[3]==='cancel')return send(res,200,{item:await svc.cancel({planId,tenantId,actor,reason:b.reason,idempotencyKey:key})});
 if(p[3]==='retry-from-checkpoint')return send(res,200,{item:await svc.retryFromCheckpoint({planId,tenantId,actor,idempotencyKey:key})});
 if(p[3]==='checkpoints'&&p[5]==='validate')return send(res,200,{item:await svc.validateCheckpoint({checkpointId:p[4],tenantId,actor,allowExpired:Boolean(b.allowExpired)})});
 if(p[3]==='checkpoints'&&p[5]==='seal')return send(res,200,{item:await svc.sealCheckpoint({checkpointId:p[4],tenantId,actor})});
 if(p[3]==='checkpoints'&&p[5]==='quarantine')return send(res,200,{item:await svc.quarantineCheckpoint({checkpointId:p[4],tenantId,actor,reason:b.reason||'operator quarantine'})});
 if(p[3]==='interventions'&&p.length===4)return send(res,201,{item:await svc.intervene({planId,tenantId,actor,kind:b.kind,stageId:b.stageId,reason:b.reason,idempotencyKey:key})});
 if(p[3]==='interventions'&&p[5]==='decide')return send(res,200,{item:await svc.decideIntervention({planId,tenantId,interventionId:p[4],decision:b.decision||b,actor,idempotencyKey:key})});
 if(p[3]==='skip-with-approval')return send(res,200,{item:await svc.skipWithApproval({planId,tenantId,stageId:b.stageId,actor,approvalReference:b.approvalReference,idempotencyKey:key})});return base(req,res);
 }catch(e){send(res,e.statusCode||422,{error:{code:e.code||'WORKFLOW_CONTROL_FAILED',message:e.message}})}});return r;};}
module.exports={installWorkflowControlHttp};
