const crypto = require('node:crypto');

const ALLOWED_ANCHORS = new Set(['EPISODE', 'VERSION', 'SCENE', 'TIMELINE_RANGE', 'ARTIFACT_TIMESTAMP']);
const ROLES = Object.freeze({ VIEWER: 1, EDITOR: 2, OWNER: 3 });

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function requestHash(value) { return sha256(canonical(value)); }
function fail(message, code, status = 400) { throw Object.assign(new Error(message), { code, statusCode: status }); }
function id() { return crypto.randomUUID(); }

function normalizeAnchor(anchorType, anchor, versionId) {
  if (!ALLOWED_ANCHORS.has(anchorType)) fail('Unsupported review anchor', 'INVALID_ANCHOR');
  if (!versionId) fail('versionId is required for version-aware review anchors', 'VERSION_REQUIRED');
  const a = anchor && typeof anchor === 'object' ? JSON.parse(JSON.stringify(anchor)) : {};
  if (anchorType === 'SCENE' && (!a.sceneId || typeof a.sceneId !== 'string')) fail('sceneId is required', 'INVALID_ANCHOR');
  if (anchorType === 'TIMELINE_RANGE') {
    if (!Number.isFinite(a.startMs) || !Number.isFinite(a.endMs) || a.startMs < 0 || a.endMs <= a.startMs) fail('Invalid timeline range', 'INVALID_ANCHOR');
  }
  if (anchorType === 'ARTIFACT_TIMESTAMP') {
    if (!a.artifactId || !Number.isFinite(a.timestampMs) || a.timestampMs < 0) fail('artifactId and timestampMs are required', 'INVALID_ANCHOR');
  }
  if (anchorType === 'EPISODE' && Object.keys(a).length) fail('Episode anchor cannot contain mutable offsets', 'INVALID_ANCHOR');
  a.versionId = versionId;
  return a;
}

class EditorialReviewService {
  constructor({ pool, events = null, logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool; this.events = events; this.logger = logger;
  }

  async withTransaction(fn) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async assertProjectAccess({ tenantId, projectId, actor, minRole = 'VIEWER', client = this.pool }) {
    const r = await client.query(`SELECT p.id,p.tenant_id,p.lifecycle_state,p.created_by,m.role
      FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$3 WHERE p.id=$1 AND p.tenant_id=$2`, [projectId, tenantId, actor]);
    const row = r.rows[0];
    const role = row?.role || (row?.created_by === actor ? 'OWNER' : null);
    if (!row || row.lifecycle_state !== 'ACTIVE' || !role || (ROLES[role] || 0) < (ROLES[minRole] || 99)) fail('Project access denied', 'FORBIDDEN', 403);
    const tenant = await client.query('SELECT lifecycle_state FROM tenants WHERE id=$1', [tenantId]);
    if (tenant.rows[0]?.lifecycle_state !== 'ACTIVE') fail('Tenant lifecycle blocks review access', 'FORBIDDEN', 403);
    return { ...row, role };
  }

  async resolveScope({ tenantId, projectId, episodeId, versionId, artifactId = null, client = this.pool }) {
    const v = await client.query(`SELECT v.id AS version_id,e.id AS episode_id,e.project_id,p.tenant_id,p.lifecycle_state AS project_state,t.lifecycle_state AS tenant_state
      FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id JOIN tenants t ON t.id=p.tenant_id
      WHERE v.id=$1 AND e.id=$2 AND e.project_id=$3`, [versionId, episodeId, projectId]);
    const row = v.rows[0];
    if (!row || row.tenant_id !== tenantId || row.project_state !== 'ACTIVE' || row.tenant_state !== 'ACTIVE') fail('Version is unavailable for review', 'STALE_VERSION', 409);
    if (artifactId) {
      const a = await client.query(`SELECT a.id,a.version_id,a.episode_id,a.metadata,p.lifecycle_state AS project_state,t.lifecycle_state AS tenant_state
        FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN tenants t ON t.id=p.tenant_id
        WHERE a.id=$1 AND a.episode_id=$2`, [artifactId, episodeId]);
      const ar = a.rows[0];
      if (!ar || ar.version_id !== versionId || ar.project_state !== 'ACTIVE' || ar.tenant_state !== 'ACTIVE') fail('Artifact is unavailable for review', 'STALE_ARTIFACT', 409);
      const lifecycle = String(ar.metadata?.lifecycleState || ar.metadata?.storageState || 'ACTIVE').toUpperCase();
      if (['DELETED', 'QUARANTINED', 'CORRUPT', 'MISSING'].includes(lifecycle)) fail('Artifact lifecycle blocks review', 'ARTIFACT_UNAVAILABLE', 409);
    }
    return row;
  }

  async idempotent({ tenantId, key, input, operation, client }) {
    if (!key) return operation();
    const hash = requestHash(input);
    const existing = await client.query('SELECT request_hash,response FROM review_idempotency WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE', [tenantId, key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash) fail('Idempotency key reused with a different request', 'IDEMPOTENCY_CONFLICT', 409);
      return existing.rows[0].response;
    }
    const response = await operation();
    await client.query('INSERT INTO review_idempotency(tenant_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)', [tenantId, key, hash, JSON.stringify(response)]);
    return response;
  }

  async audit(client, { tenantId, projectId, episodeId, actor, action, targetType, targetId, details = {} }) {
    await client.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,current_setting('forge.request_id',true),$7::jsonb)`, [projectId, episodeId, actor, action, targetType, targetId, JSON.stringify(details)]);
  }

  async publish(client, { tenantId, projectId, episodeId, type, payload, aggregateType, aggregateId }) {
    if (!this.events) return;
    await this.events.publish({ client, tenantId, projectId, episodeId, type, payload, aggregateType, aggregateId, provenance: { subsystem: 'editorial-review' } });
  }

  async createThread(input, ctx) {
    const { tenantId, actor, projectId, episodeId, versionId, anchorType, anchor, title, severity = 'NORMAL', requiredForRelease = false, metadata = {}, idempotencyKey } = input;
    if (!title || title.length > 500) fail('title is required and must be <= 500 characters', 'INVALID_TITLE');
    if (!['INFO', 'NORMAL', 'MAJOR', 'BLOCKER'].includes(severity)) fail('Invalid severity', 'INVALID_SEVERITY');
    return this.withTransaction(async client => this.idempotent({ tenantId, key: idempotencyKey, input, client, operation: async () => {
      await this.assertProjectAccess({ tenantId, projectId, actor, minRole: 'EDITOR', client });
      const normalizedAnchor = normalizeAnchor(anchorType, anchor, versionId);
      await this.resolveScope({ tenantId, projectId, episodeId, versionId, artifactId: anchorType === 'ARTIFACT_TIMESTAMP' ? normalizedAnchor.artifactId : null, client });
      const threadId = id();
      const row = (await client.query(`INSERT INTO review_threads(id,tenant_id,project_id,episode_id,version_id,anchor_type,anchor,title,severity,required_for_release,created_by,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb) RETURNING *`, [threadId,tenantId,projectId,episodeId,versionId,anchorType,JSON.stringify(normalizedAnchor),title,severity,Boolean(requiredForRelease),actor,JSON.stringify(metadata)])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId,actor,action:'REVIEW_THREAD_CREATED',targetType:'review_thread',targetId:threadId,details:{versionId,anchorType,severity,requiredForRelease}});
      await this.publish(client,{tenantId,projectId,episodeId,type:'review.thread.created',aggregateType:'review_thread',aggregateId:threadId,payload:{threadId,episodeId,projectId,versionId,state:'OPEN'}});
      return row;
    }});
  }

  async listThreads({ tenantId, actor, projectId, episodeId, versionId, state = null, limit = 100, cursor = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1..200', 'INVALID_LIMIT');
    await this.assertProjectAccess({ tenantId, projectId, actor, minRole: 'VIEWER' });
    const args = [tenantId, projectId, episodeId, versionId, state, limit];
    const cursorClause = cursor ? 'AND (created_at,id) > ($7::timestamptz,$8)' : '';
    if (cursor) { const [at, idValue] = String(cursor).split('|'); args.push(at, idValue); }
    const r = await this.pool.query(`SELECT * FROM review_threads WHERE tenant_id=$1 AND project_id=$2 AND episode_id=$3 AND version_id=$4 AND ($5::text IS NULL OR state=$5) ${cursorClause}
      ORDER BY created_at ASC,id ASC LIMIT $6`, args);
    return { items: r.rows, nextCursor: r.rows.length === limit ? `${r.rows[r.rows.length-1].created_at.toISOString()}|${r.rows[r.rows.length-1].id}` : null };
  }

  async addComment({ tenantId, actor, projectId, threadId, body, mentions = [], attachmentRefs = [], idempotencyKey }) {
    if (typeof body !== 'string' || !body.trim() || body.length > 20000) fail('body is required and must be <= 20000 characters', 'INVALID_BODY');
    return this.withTransaction(async client => this.idempotent({ tenantId, key: idempotencyKey, input: {projectId,threadId,body,mentions,attachmentRefs}, client, operation: async () => {
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'EDITOR',client});
      const thread = (await client.query('SELECT * FROM review_threads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[threadId,tenantId,projectId])).rows[0];
      if (!thread) fail('Review thread not found', 'NOT_FOUND', 404);
      await this.resolveScope({tenantId,projectId,episodeId:thread.episode_id,versionId:thread.version_id,client});
      await this.validateMentions({client,projectId,mentions});
      await this.validateAttachments({client,tenantId,projectId,episodeId:thread.episode_id,versionId:thread.version_id,attachmentRefs});
      const next = Number((await client.query('SELECT COALESCE(MAX(revision),0)+1 revision FROM review_comment_revisions WHERE thread_id=$1 FOR UPDATE',[threadId])).rows[0].revision);
      const commentId = id();
      const row = (await client.query(`INSERT INTO review_comment_revisions(id,tenant_id,project_id,thread_id,revision,body,mentions,attachment_refs,operation,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'CREATE',$9) RETURNING *`,[commentId,tenantId,projectId,threadId,next,body,JSON.stringify(mentions),JSON.stringify(attachmentRefs),actor])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId:thread.episode_id,actor,action:'REVIEW_COMMENT_CREATED',targetType:'review_comment',targetId:commentId,details:{threadId,revision:next,versionId:thread.version_id}});
      await this.publish(client,{tenantId,projectId,episodeId:thread.episode_id,type:'review.comment.created',aggregateType:'review_thread',aggregateId:threadId,payload:{threadId,commentId,episodeId:thread.episode_id,projectId,versionId:thread.version_id}});
      return row;
    }});
  }

  async validateMentions({ client, projectId, mentions }) {
    if (!Array.isArray(mentions) || mentions.length > 50 || mentions.some(x => typeof x !== 'string')) fail('mentions must be actor ids', 'INVALID_MENTIONS');
    if (!mentions.length) return;
    const r = await client.query('SELECT actor_id FROM project_members WHERE project_id=$1 AND actor_id=ANY($2::text[])',[projectId,mentions]);
    if (r.rows.length !== new Set(mentions).size) fail('Mention target is outside the project', 'MENTION_FORBIDDEN', 403);
  }

  async validateAttachments({ client, tenantId, projectId, episodeId, versionId, attachmentRefs }) {
    if (!Array.isArray(attachmentRefs) || attachmentRefs.length > 20 || attachmentRefs.some(x => typeof x !== 'string')) fail('attachmentRefs must contain artifact ids', 'INVALID_ATTACHMENTS');
    if (!attachmentRefs.length) return;
    const r = await client.query(`SELECT a.id,a.version_id,a.metadata,p.tenant_id,p.id project_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      WHERE a.id=ANY($1::text[]) AND a.episode_id=$2`,[attachmentRefs,episodeId]);
    if (r.rows.length !== new Set(attachmentRefs).size || r.rows.some(a => a.version_id!==versionId || a.project_id!==projectId || a.tenant_id!==tenantId || ['DELETED','QUARANTINED','CORRUPT','MISSING'].includes(String(a.metadata?.lifecycleState||a.metadata?.storageState||'ACTIVE').toUpperCase()))) fail('Attachment is not valid for the immutable review version', 'ATTACHMENT_FORBIDDEN', 409);
  }

  async editComment({ tenantId, actor, projectId, commentId, expectedRevision, body, mentions, attachmentRefs }) {
    return this.withTransaction(async client => {
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'EDITOR',client});
      const current = (await client.query(`SELECT c.*,t.episode_id,t.version_id FROM review_comment_revisions c JOIN review_threads t ON t.id=c.thread_id
        WHERE c.thread_id=(SELECT thread_id FROM review_comment_revisions WHERE id=$1) AND c.operation<>'DELETE' ORDER BY c.revision DESC LIMIT 1 FOR UPDATE`,[commentId])).rows[0];
      if (!current) fail('Comment not found', 'NOT_FOUND', 404);
      if (current.project_id !== projectId) fail('Comment access denied', 'FORBIDDEN', 403);
      if (Number(current.revision) !== Number(expectedRevision)) fail('Comment revision conflict', 'REVISION_CONFLICT', 409);
      await this.resolveScope({tenantId,projectId,episodeId:current.episode_id,versionId:current.version_id,client});
      await this.validateMentions({client,projectId,mentions});
      await this.validateAttachments({client,tenantId,projectId,episodeId:current.episode_id,versionId:current.version_id,attachmentRefs});
      const next=Number(current.revision)+1;
      const row=(await client.query(`INSERT INTO review_comment_revisions(id,tenant_id,project_id,thread_id,revision,body,mentions,attachment_refs,operation,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'EDIT',$9) RETURNING *`,[id(),tenantId,projectId,current.thread_id,next,body,JSON.stringify(mentions||[]),JSON.stringify(attachmentRefs||[]),actor])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId:current.episode_id,actor,action:'REVIEW_COMMENT_EDITED',targetType:'review_comment',targetId:commentId,details:{threadId:current.thread_id,fromRevision:current.revision,toRevision:next,versionId:current.version_id}});
      return row;
    });
  }

  async deleteComment({ tenantId, actor, projectId, commentId, expectedRevision }) {
    return this.withTransaction(async client => {
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'EDITOR',client});
      const current=(await client.query(`SELECT c.*,t.episode_id,t.version_id FROM review_comment_revisions c JOIN review_threads t ON t.id=c.thread_id WHERE c.id=$1 AND c.project_id=$2`,[commentId,projectId])).rows[0];
      if(!current)fail('Comment not found','NOT_FOUND',404);
      const latest=(await client.query('SELECT revision,operation FROM review_comment_revisions WHERE thread_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[current.thread_id])).rows[0];
      if(Number(latest.revision)!==Number(expectedRevision))fail('Comment revision conflict','REVISION_CONFLICT',409);
      const row=(await client.query(`INSERT INTO review_comment_revisions(id,tenant_id,project_id,thread_id,revision,body,mentions,attachment_refs,operation,actor)
        VALUES($1,$2,$3,$4,$5,'', '[]'::jsonb,'[]'::jsonb,'DELETE',$6) RETURNING *`,[id(),tenantId,projectId,current.thread_id,Number(latest.revision)+1,actor])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId:current.episode_id,actor,action:'REVIEW_COMMENT_DELETED',targetType:'review_comment',targetId:commentId,details:{threadId:current.thread_id,tombstoneRevision:row.revision,versionId:current.version_id}});
      return row;
    });
  }

  async resolveThread({ tenantId, actor, projectId, threadId, expectedRevision, state = 'RESOLVED' }) {
    if (!['RESOLVED','REOPENED'].includes(state)) fail('Invalid review state','INVALID_STATE');
    return this.withTransaction(async client => {
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'EDITOR',client});
      const t=(await client.query('SELECT * FROM review_threads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[threadId,tenantId,projectId])).rows[0];
      if(!t)fail('Review thread not found','NOT_FOUND',404);
      if(Number(t.revision)!==Number(expectedRevision))fail('Thread revision conflict','REVISION_CONFLICT',409);
      await this.resolveScope({tenantId,projectId,episodeId:t.episode_id,versionId:t.version_id,client});
      const next=Number(t.revision)+1;
      const row=(await client.query(`UPDATE review_threads SET state=$1,revision=$2,resolved_by=$3,resolved_at=CASE WHEN $1='RESOLVED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$4 AND revision=$5 RETURNING *`,[state,next,actor,threadId,t.revision])).rows[0];
      if(!row)fail('Thread revision conflict','REVISION_CONFLICT',409);
      await this.audit(client,{tenantId,projectId,episodeId:t.episode_id,actor,action:state==='RESOLVED'?'REVIEW_THREAD_RESOLVED':'REVIEW_THREAD_REOPENED',targetType:'review_thread',targetId:threadId,details:{from:t.state,to:state,versionId:t.version_id}});
      if(state==='RESOLVED')await this.publish(client,{tenantId,projectId,episodeId:t.episode_id,type:'review.thread.resolved',aggregateType:'review_thread',aggregateId:threadId,payload:{threadId,episodeId:t.episode_id,projectId,versionId:t.version_id,state}});
      return row;
    });
  }

  async decide({ tenantId, actor, projectId, threadId, decision, rationale = '', idempotencyKey }) {
    if(!['APPROVED','CHANGES_REQUESTED','REJECTED'].includes(decision))fail('Invalid decision','INVALID_DECISION');
    return this.withTransaction(async client=>this.idempotent({tenantId,key:idempotencyKey,input:{projectId,threadId,decision,rationale},client,operation:async()=>{
      await this.assertProjectAccess({tenantId,projectId,actor,minRole:'OWNER',client});
      const t=(await client.query('SELECT * FROM review_threads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[threadId,tenantId,projectId])).rows[0];
      if(!t)fail('Review thread not found','NOT_FOUND',404);
      await this.resolveScope({tenantId,projectId,episodeId:t.episode_id,versionId:t.version_id,client});
      const evidenceHash=sha256(canonical({threadId,versionId:t.version_id,decision,rationale,actor}));
      const row=(await client.query(`INSERT INTO review_decisions(id,tenant_id,project_id,episode_id,version_id,thread_id,decision,actor,rationale,evidence_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id(),tenantId,projectId,t.episode_id,t.version_id,threadId,decision,actor,rationale,evidenceHash])).rows[0];
      await this.audit(client,{tenantId,projectId,episodeId:t.episode_id,actor,action:'REVIEW_DECISION_RECORDED',targetType:'review_decision',targetId:row.id,details:{threadId,versionId:t.version_id,decision,evidenceHash}});
      await this.publish(client,{tenantId,projectId,episodeId:t.episode_id,type:'review.decision.recorded',aggregateType:'review_thread',aggregateId:threadId,payload:{decisionId:row.id,threadId,episodeId:t.episode_id,projectId,versionId:t.version_id,decision}});
      return row;
    }}));
  }

  async gate({ tenantId, projectId, episodeId, versionId }) {
    const r=await this.pool.query(`SELECT t.id,t.severity,t.state,t.required_for_release,t.version_id,t.title,
      EXISTS(SELECT 1 FROM review_decisions d WHERE d.thread_id=t.id AND d.version_id=t.version_id AND d.decision='APPROVED') AS approved
      FROM review_threads t WHERE t.tenant_id=$1 AND t.project_id=$2 AND t.episode_id=$3 AND t.version_id=$4 ORDER BY t.created_at,t.id`,[tenantId,projectId,episodeId,versionId]);
    const req=(await this.pool.query('SELECT * FROM review_gate_requirements WHERE project_id=$1',[projectId])).rows[0]||{block_on_required_findings:true,require_decision_for_release:false,minimum_approvals:1};
    const blocking=r.rows.filter(x=>x.required_for_release&&(x.state!=='RESOLVED'||(x.severity==='BLOCKER'&&!x.approved)));
    const approvals=new Set(r.rows.filter(x=>x.approved).map(x=>x.id));
    const blocked=Boolean(req.block_on_required_findings&&blocking.length)||(req.require_decision_for_release&&approvals.size<Number(req.minimum_approvals));
    return {allowed:!blocked,blockingFindings:blocking,approvedDecisionCount:approvals.size,requiredApprovals:Number(req.minimum_approvals),reason:blocked?'EDITORIAL_REVIEW_REQUIRED':'PASS'};
  }

  async exportBundle({ tenantId, actor, projectId, episodeId, versionId }) {
    await this.assertProjectAccess({tenantId,projectId,actor,minRole:'VIEWER'});
    const scope=await this.resolveScope({tenantId,projectId,episodeId,versionId});
    const threads=(await this.pool.query('SELECT * FROM review_threads WHERE tenant_id=$1 AND project_id=$2 AND episode_id=$3 AND version_id=$4 ORDER BY created_at,id',[tenantId,projectId,episodeId,versionId])).rows;
    const ids=threads.map(t=>t.id);
    const comments=ids.length?(await this.pool.query('SELECT * FROM review_comment_revisions WHERE tenant_id=$1 AND project_id=$2 AND thread_id=ANY($3::text[]) ORDER BY thread_id,revision,id',[tenantId,projectId,ids])).rows:[];
    const decisions=ids.length?(await this.pool.query('SELECT * FROM review_decisions WHERE tenant_id=$1 AND project_id=$2 AND thread_id=ANY($3::text[]) ORDER BY thread_id,created_at,id',[tenantId,projectId,ids])).rows:[];
    const body={schemaVersion:1,tenantId,projectId,episodeId,versionId,threads,comments,decisions};
    return {bundle:body,checksum:sha256(canonical(body))};
  }

  async replayBundle({ tenantId, actor, projectId, episodeId, versionId, bundle, checksum }) {
    await this.assertProjectAccess({tenantId,projectId,actor,minRole:'OWNER'});
    if(!bundle||bundle.schemaVersion!==1||bundle.tenantId!==tenantId||bundle.projectId!==projectId||bundle.episodeId!==episodeId||bundle.versionId!==versionId)fail('Replay scope mismatch','REPLAY_SCOPE_MISMATCH',409);
    if(checksum!==sha256(canonical(bundle)))fail('Replay checksum mismatch','REPLAY_CHECKSUM_MISMATCH',409);
    await this.resolveScope({tenantId,projectId,episodeId,versionId});
    return this.withTransaction(async client=>{
      const ordered=[...(bundle.threads||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      for(const t of ordered){
        await client.query(`INSERT INTO review_threads(id,tenant_id,project_id,episode_id,version_id,anchor_type,anchor,title,severity,state,required_for_release,revision,created_by,created_at,resolved_by,resolved_at,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT(id) DO NOTHING`,[t.id,tenantId,projectId,episodeId,versionId,t.anchor_type,t.anchor,t.title,t.severity,t.state,t.required_for_release,t.revision,t.created_by,t.created_at,t.resolved_by,t.resolved_at,t.metadata]);
      }
      for(const c of [...(bundle.comments||[])].sort((a,b)=>String(a.thread_id).localeCompare(String(b.thread_id))||Number(a.revision)-Number(b.revision)||String(a.id).localeCompare(String(b.id)))await client.query(`INSERT INTO review_comment_revisions(id,tenant_id,project_id,thread_id,revision,body,mentions,attachment_refs,operation,actor,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,[c.id,tenantId,projectId,c.thread_id,c.revision,c.body,c.mentions,c.attachment_refs,c.operation,c.actor,c.created_at]);
      for(const d of [...(bundle.decisions||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)))await client.query(`INSERT INTO review_decisions(id,tenant_id,project_id,episode_id,version_id,thread_id,decision,actor,rationale,evidence_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,[d.id,tenantId,projectId,episodeId,versionId,d.thread_id,d.decision,d.actor,d.rationale,d.evidence_hash,d.created_at]);
      const replayHash=sha256(canonical({threads:ordered,comments:bundle.comments||[],decisions:bundle.decisions||[]}));
      await client.query(`INSERT INTO review_replay_checkpoints(project_id,version_id,replay_hash,event_count) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,version_id) DO UPDATE SET replay_hash=EXCLUDED.replay_hash,event_count=EXCLUDED.event_count,created_at=now()`,[projectId,versionId,replayHash,ordered.length+(bundle.comments||[]).length+(bundle.decisions||[]).length]);
      await this.audit(client,{tenantId,projectId,episodeId,actor,action:'REVIEW_BUNDLE_REPLAYED',targetType:'review_bundle',targetId:versionId,details:{replayHash,eventCount:ordered.length+(bundle.comments||[]).length+(bundle.decisions||[]).length}});
      return {replayed:true,replayHash};
    });
  }

  async diagnostics({tenantId,projectId=null}) {
    const where=projectId?'tenant_id=$1 AND project_id=$2':'tenant_id=$1'; const args=projectId?[tenantId,projectId]:[tenantId];
    const [threads,comments,decisions,blocking]=await Promise.all([
      this.pool.query(`SELECT state,count(*)::int count FROM review_threads WHERE ${where} GROUP BY state ORDER BY state`,args),
      this.pool.query(`SELECT count(*)::int count FROM review_comment_revisions WHERE ${where}`,args),
      this.pool.query(`SELECT decision,count(*)::int count FROM review_decisions WHERE ${where} GROUP BY decision ORDER BY decision`,args),
      this.pool.query(`SELECT count(*)::int count FROM review_threads WHERE ${where} AND required_for_release AND state<>'RESOLVED'`,args),
    ]);
    return {status:'ok',threads:threads.rows,comments:comments.rows[0]?.count||0,decisions:decisions.rows,blockingFindings:blocking.rows[0]?.count||0};
  }
}
module.exports={EditorialReviewService,canonical,sha256,requestHash};
