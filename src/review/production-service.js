const { EditorialReviewService } = require('./editorial-review');
const crypto = require('node:crypto');
function fail(message, code, status=400){throw Object.assign(new Error(message),{code,statusCode:status});}
function id(){return crypto.randomUUID();}
class ProductionEditorialReviewService extends EditorialReviewService {
  async idempotent({tenantId,key,input,operation,client}){
    if(!key)return operation();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${tenantId}:${key}`]);
    const hash=crypto.createHash('sha256').update(require('./editorial-review').canonical(input)).digest('hex');
    const existing=await client.query('SELECT request_hash,response FROM review_idempotency WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,key]);
    if(existing.rows[0]){if(existing.rows[0].request_hash!==hash)fail('Idempotency key reused with a different request','IDEMPOTENCY_CONFLICT',409);return existing.rows[0].response;}
    const response=await operation();
    await client.query('INSERT INTO review_idempotency(tenant_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',[tenantId,key,hash,JSON.stringify(response)]);
    return response;
  }
  async addComment({tenantId,actor,projectId,threadId,body,mentions=[],attachmentRefs=[],idempotencyKey}){
    if(typeof body!=='string'||!body.trim()||body.length>20000)fail('body is required and must be <= 20000 characters','INVALID_BODY');
    return this.withTransaction(async client=>this.idempotent({tenantId,key:idempotencyKey,input:{projectId,threadId,body,mentions,attachmentRefs},client,operation:async()=>{
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'EDITOR',client});
      const thread=(await client.query('SELECT * FROM review_threads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[threadId,tenantId,projectId])).rows[0];
      if(!thread)fail('Review thread not found','NOT_FOUND',404);
      await this.resolveScope({tenantId,projectId,episodeId:thread.episode_id,versionId:thread.version_id,client});
      await this.validateMentions({client,projectId,mentions});
      await this.validateAttachments({client,tenantId,projectId,episodeId:thread.episode_id,versionId:thread.version_id,attachmentRefs});
      const latest=(await client.query('SELECT revision FROM review_comment_revisions WHERE thread_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[threadId])).rows[0];
      const next=Number(latest?.revision||0)+1;
      const commentId=id();
      const row=(await client.query(`INSERT INTO review_comment_revisions(id,tenant_id,project_id,thread_id,revision,body,mentions,attachment_refs,operation,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'CREATE',$9) RETURNING *`,[commentId,tenantId,projectId,threadId,next,body,JSON.stringify(mentions),JSON.stringify(attachmentRefs),actor])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId:thread.episode_id,actor,action:'REVIEW_COMMENT_CREATED',targetType:'review_comment',targetId:commentId,details:{threadId,revision:next,versionId:thread.version_id}});
      await this.publish(client,{tenantId,projectId,episodeId:thread.episode_id,type:'review.comment.created',aggregateType:'review_thread',aggregateId:threadId,payload:{threadId,commentId,episodeId:thread.episode_id,projectId,versionId:thread.version_id}});
      return row;
    }});
  }
}
module.exports={ProductionEditorialReviewService};
