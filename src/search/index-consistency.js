const crypto = require('node:crypto');

const DEFAULT_BATCH = 500;
const MAX_BATCH = 2000;
const MAX_REPAIR = 500;
const SCHEMA_VERSION = 2;

const SOURCE_SQL = `
WITH source_rows AS (
  SELECT p.tenant_id,p.id::text project_id,'project'::text source_type,p.id::text source_id,NULL::text episode_id,
    coalesce(p.name,'') title,left(coalesce(p.metadata,'{}'::jsonb)::text,16000) content,NULL::text state,NULL::text stage,NULL::text provider,NULL::text artifact_kind,
    coalesce(p.created_at,now()) occurred_at,coalesce(p.updated_at,p.created_at,now()) source_updated_at,coalesce(p.metadata,'{}'::jsonb) metadata
  FROM projects p
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'episode',e.id::text,e.id::text,coalesce(e.title,''),coalesce(e.description,'')||' '||coalesce(e.state,''),NULL,NULL,NULL,NULL,coalesce(e.created_at,now()),coalesce(e.updated_at,e.created_at,now()),coalesce(e.metadata,'{}'::jsonb)
  FROM episodes e JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'version',v.id::text,e.id::text,coalesce(v.kind,'')||' '||v.id::text,left(coalesce(v.payload,'{}'::jsonb)::text,16000),NULL,NULL,NULL,NULL,coalesce(v.created_at,now()),coalesce(v.updated_at,v.created_at,now()),coalesce(v.payload,'{}'::jsonb)
  FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'artifact',a.id::text,e.id::text,coalesce(a.kind,'')||' '||coalesce(a.media_type,''),coalesce(a.content_hash,'')||' '||coalesce(a.source,''),NULL,NULL,NULL,coalesce(a.kind,''),coalesce(a.created_at,now()),coalesce(a.updated_at,a.created_at,now()),coalesce(a.metadata,'{}'::jsonb)
  FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,coalesce(j.project_id,e.project_id)::text,'job',j.id::text,j.episode_id::text,coalesce(j.kind,'')||' '||coalesce(j.status,''),coalesce(j.worker_id,'')||' '||left(coalesce(j.error,'{}'::jsonb)::text,6000)||' '||left(coalesce(j.result,'{}'::jsonb)::text,6000),coalesce(j.status,''),coalesce(j.stage,''),NULL,NULL,coalesce(j.created_at,now()),coalesce(j.updated_at,j.created_at,now()),jsonb_build_object('priority',j.priority,'attempts',j.attempts,'maxAttempts',j.max_attempts)
  FROM forge_jobs j LEFT JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=coalesce(j.project_id,e.project_id)
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR coalesce(j.project_id,e.project_id)=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'provider_run',r.id::text,r.episode_id::text,coalesce(r.capability,'')||' '||coalesce(r.provider,'')||' '||coalesce(r.model,''),coalesce(r.external_job_id,'')||' '||left(coalesce(r.error,'{}'::jsonb)::text,6000),NULL,NULL,coalesce(r.provider,''),NULL,coalesce(r.created_at,now()),coalesce(r.updated_at,r.created_at,now()),jsonb_build_object('attempt',r.attempt,'idempotencyKey',r.idempotency_key)
  FROM provider_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'approval',a.id::text,a.episode_id::text,coalesce(a.stage,'')||' '||coalesce(a.decision,''),coalesce(a.actor,'')||' '||left(coalesce(a.comments,''),6000),coalesce(a.decision,''),coalesce(a.stage,''),NULL,NULL,coalesce(a.created_at,now()),coalesce(a.updated_at,a.created_at,now()),coalesce(a.evidence,'{}'::jsonb)
  FROM approvals a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'qa',q.id::text,q.episode_id::text,coalesce(q.status,'')||' '||coalesce(q.runner,''),left(coalesce(q.checks,'[]'::jsonb)::text,12000),coalesce(q.status,''),NULL,NULL,NULL,coalesce(q.created_at,now()),coalesce(q.updated_at,q.created_at,now()),coalesce(q.metadata,'{}'::jsonb)
  FROM qa_results q JOIN episodes e ON e.id=q.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'publish_run',r.id::text,r.episode_id::text,coalesce(r.destination,'')||' '||coalesce(r.status,''),coalesce(r.external_id,'')||' '||coalesce(r.external_url,''),coalesce(r.status,''),NULL,NULL,NULL,coalesce(r.created_at,now()),coalesce(r.updated_at,r.created_at,now()),coalesce(r.metadata,'{}'::jsonb)
  FROM publish_runs r JOIN episodes e ON e.id=r.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,e.project_id::text,'cost',c.id::text,c.episode_id::text,coalesce(c.provider,'')||' '||coalesce(c.operation,''),coalesce(c.model,'')||' '||coalesce(c.currency,''),NULL,NULL,coalesce(c.provider,''),NULL,coalesce(c.created_at,now()),coalesce(c.updated_at,c.created_at,now()),coalesce(c.metadata,'{}'::jsonb)
  FROM cost_records c JOIN episodes e ON e.id=c.episode_id JOIN projects p ON p.id=e.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)
  UNION ALL
  SELECT p.tenant_id,coalesce(a.project_id,e.project_id)::text,'audit_event',a.id::text,a.episode_id::text,coalesce(a.action,'')||' '||coalesce(a.target_type,''),coalesce(a.actor,'')||' '||coalesce(a.target_id,''),NULL,NULL,NULL,NULL,coalesce(a.created_at,now()),coalesce(a.updated_at,a.created_at,now()),coalesce(a.details,'{}'::jsonb)
  FROM audit_events a LEFT JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=coalesce(a.project_id,e.project_id)
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR coalesce(a.project_id,e.project_id)=$2)
  UNION ALL
  SELECT p.tenant_id,coalesce(u.project_id,e.project_id)::text,'usage',u.id::text,u.episode_id::text,coalesce(u.kind,'')||' '||coalesce(u.provider,''),coalesce(u.metric,'')||' '||coalesce(u.unit,''),NULL,NULL,coalesce(u.provider,''),NULL,coalesce(u.created_at,now()),coalesce(u.updated_at,u.created_at,now()),coalesce(u.metadata,'{}'::jsonb)
  FROM usage_events u LEFT JOIN episodes e ON e.id=u.episode_id JOIN projects p ON p.id=coalesce(u.project_id,e.project_id)
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR coalesce(u.project_id,e.project_id)=$2)
  UNION ALL
  SELECT p.tenant_id,b.project_id::text,'budget',b.id::text,NULL::text,coalesce(b.name,'')||' '||coalesce(b.state,''),left(coalesce(b.metadata,'{}'::jsonb)::text,12000),coalesce(b.state,''),NULL,NULL,NULL,coalesce(b.created_at,now()),coalesce(b.updated_at,b.created_at,now()),coalesce(b.metadata,'{}'::jsonb)
  FROM usage_budgets b JOIN projects p ON p.id=b.project_id
  WHERE p.tenant_id=$1 AND ($2::text IS NULL OR b.project_id=$2)
)
SELECT * FROM source_rows
WHERE ($3::text IS NULL OR source_type>$3 OR (source_type=$3 AND source_id>$4))
ORDER BY source_type,source_id
LIMIT $5`;

function uuid() { return `search-gen-${Date.now()}-${crypto.randomUUID()}`; }
function boundedInt(value, fallback, max) { const n=Number(value); return Number.isInteger(n)&&n>0 ? Math.min(n,max) : fallback; }
function queryFingerprint(row) { return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex'); }

class SearchIndexConsistencyService {
  constructor({ pool, logger = console, failureInjector = null, batchSize = DEFAULT_BATCH }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pg pool is required');
    this.pool = pool;
    this.logger = logger;
    this.failureInjector = failureInjector;
    this.batchSize = boundedInt(batchSize, DEFAULT_BATCH, MAX_BATCH);
  }

  async health({ tenantId, projectId = null }) {
    const params=[tenantId,projectId];
    const [meta,events,docs,generations] = await Promise.all([
      this.pool.query('SELECT * FROM forge_search_index_meta WHERE singleton=true'),
      this.pool.query({text:`SELECT coalesce(max(event_id),0)::bigint latest_event_id, count(*)::bigint event_count FROM forge_search_index_events WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:params}),
      this.pool.query({text:`SELECT count(*)::bigint indexed_count,count(*) FILTER (WHERE tenant_id<>$1)::bigint cross_tenant_count,max(indexed_at) last_indexed_at,max(source_updated_at) last_source_update FROM forge_search_documents WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:params}),
      this.pool.query({text:`SELECT generation_id,state,processed,expected,last_applied_event_id,failure_state,updated_at FROM forge_search_index_generations WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 20`,values:params}),
    ]);
    const m=meta.rows[0]||{}; const e=events.rows[0]||{};
    return {schemaVersion:m.schema_version||null,activeGeneration:m.active_generation||null,generationEpoch:Number(m.generation_epoch||0),lastAppliedEventId:Number(m.last_applied_event_id||0),latestEventId:Number(e.latest_event_id||0),lag:Math.max(0,Number(e.latest_event_id||0)-Number(m.last_applied_event_id||0)),indexedCount:Number(docs.rows[0]?.indexed_count||0),crossTenantCount:Number(docs.rows[0]?.cross_tenant_count||0),lastIndexedAt:docs.rows[0]?.last_indexed_at||null,lastSourceUpdate:docs.rows[0]?.last_source_update||null,state:m.state||'UNKNOWN',failureState:m.failure_state||null,generations:generations.rows.map(g=>({...g,processed:Number(g.processed),expected:g.expected==null?null:Number(g.expected),lastAppliedEventId:Number(g.last_applied_event_id||0)}))};
  }

  async createRebuild({ tenantId, actor, projectId = null }) {
    const id=uuid();
    const snapshot=await this.pool.query({text:'SELECT coalesce(max(event_id),0)::bigint event_id FROM forge_search_index_events WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)',values:[tenantId,projectId]});
    const startEvent=Number(snapshot.rows[0]?.event_id||0);
    await this.pool.query({text:`INSERT INTO forge_search_index_generations(generation_id,tenant_id,project_id,state,schema_version,source_snapshot_at,start_event_id,last_applied_event_id,created_by,started_at) VALUES($1,$2,$3,'BUILDING',$4,clock_timestamp(),$5,$5,$6,now())`,values:[id,tenantId,projectId,SCHEMA_VERSION,startEvent,actor]});
    await this.pool.query({text:`UPDATE forge_search_index_meta SET state='REBUILDING',updated_at=now() WHERE singleton=true`});
    return this.getGeneration({tenantId,generationId:id});
  }

  async getGeneration({ tenantId, generationId }) {
    const r=await this.pool.query({text:'SELECT * FROM forge_search_index_generations WHERE generation_id=$1 AND tenant_id=$2',values:[generationId,tenantId]});
    if(!r.rows[0]){const e=new Error('rebuild not found');e.statusCode=404;e.code='NOT_FOUND';throw e;}
    return r.rows[0];
  }

  async run({ tenantId, actor, generationId, maxBatches = 10 }) {
    const batches=boundedInt(maxBatches,10,100);
    let result=null;
    for(let i=0;i<batches;i++){
      result=await this.runBatch({tenantId,actor,generationId});
      if(result.state==='ACTIVE'||result.state==='FAILED') break;
    }
    return result||this.getGeneration({tenantId,generationId});
  }

  async runBatch({ tenantId, actor, generationId }) {
    const g=await this.getGeneration({tenantId,generationId});
    if(g.state==='ACTIVE'||g.state==='FAILED') return g;
    try{
      if(this.failureInjector) await this.failureInjector({point:'before_batch',generation:g});
      const batchSize=this.batchSize;
      const source=await this.pool.query({text:SOURCE_SQL,values:[tenantId,g.project_id,g.checkpoint_type,g.checkpoint_id,batchSize]});
      if(source.rows.length){
        await this.pool.query('BEGIN');
        try{
          for(const row of source.rows){
            if(this.failureInjector) await this.failureInjector({point:'before_row',generation:g,row});
            await this.upsertGenerationRow(generationId,row);
          }
          const last=source.rows[source.rows.length-1];
          await this.pool.query({text:`UPDATE forge_search_index_generations SET checkpoint_type=$2,checkpoint_id=$3,processed=processed+$4,updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`,values:[generationId,last.source_type,last.source_id,source.rows.length]});
          await this.pool.query('COMMIT');
        }catch(error){await this.pool.query('ROLLBACK');throw error;}
        return this.getGeneration({tenantId,generationId});
      }
      return this.verifyAndCutover({tenantId,actor,generationId});
    }catch(error){
      await this.pool.query({text:`UPDATE forge_search_index_generations SET state='FAILED',failure_state='BUILD_ERROR',failure_detail=$2,updated_at=now() WHERE generation_id=$1`,values:[generationId,String(error.stack||error).slice(0,8000)]}).catch(()=>{});
      await this.pool.query({text:`UPDATE forge_search_index_meta SET state='DEGRADED',failure_state=$1,updated_at=now() WHERE singleton=true`,values:[String(error.message||error).slice(0,2000)]}).catch(()=>{});
      throw error;
    }
  }

  async upsertGenerationRow(generationId,row){
    const fingerprintResult=await this.pool.query({text:`SELECT forge_search_document_fingerprint($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) fingerprint`,values:[row.project_id,row.tenant_id,row.source_type,row.source_id,row.episode_id,row.title,row.content,row.state,row.stage,row.provider,row.artifact_kind,row.occurred_at,row.source_updated_at,row.metadata]});
    const fp=fingerprintResult.rows[0].fingerprint;
    await this.pool.query({text:`INSERT INTO forge_search_generation_documents(generation_id,project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,indexed_at)
      VALUES($1,$2,$3,$4,$5,$6,left(coalesce($7,''),2048),left(coalesce($8,''),16000),$9,$10,$11,$12,$13,$14,$15,setweight(to_tsvector('simple',left(coalesce($7,''),2048)),'A')||setweight(to_tsvector('simple',left(coalesce($8,''),16000)),'B')||setweight(to_tsvector('simple',$4||' '||$5),'C'),coalesce($16,'{}'::jsonb),now())
      ON CONFLICT(generation_id,project_id,source_type,source_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,episode_id=EXCLUDED.episode_id,title=EXCLUDED.title,content=EXCLUDED.content,state=EXCLUDED.state,stage=EXCLUDED.stage,provider=EXCLUDED.provider,artifact_kind=EXCLUDED.artifact_kind,occurred_at=EXCLUDED.occurred_at,source_updated_at=EXCLUDED.source_updated_at,source_fingerprint=EXCLUDED.source_fingerprint,search_vector=EXCLUDED.search_vector,metadata=EXCLUDED.metadata,indexed_at=now()`,values:[generationId,row.project_id,row.tenant_id,row.source_type,row.source_id,row.episode_id,row.title,row.content,row.state,row.stage,row.provider,row.artifact_kind,row.occurred_at,row.source_updated_at,fp,row.metadata]});
  }

  async replayEvents({ tenantId, generationId, afterEventId, throughEventId }) {
    const events=await this.pool.query({text:`SELECT * FROM forge_search_index_events WHERE tenant_id=$1 AND event_id>$2 AND event_id<=$3 ORDER BY event_id`,values:[tenantId,afterEventId,throughEventId]});
    let duplicate=0,outOfOrder=0,last=afterEventId;
    for(const event of events.rows){
      if(event.event_id<=last){outOfOrder++;continue;}
      last=Number(event.event_id);
      const applied=await this.pool.query({text:`INSERT INTO forge_search_index_event_applications(generation_id,event_id,outcome) VALUES($1,$2,'APPLIED') ON CONFLICT DO NOTHING RETURNING event_id`,values:[generationId,event.event_id]});
      if(!applied.rowCount){duplicate++;continue;}
      if(event.operation==='DELETE'){
        await this.pool.query({text:`DELETE FROM forge_search_generation_documents WHERE generation_id=$1 AND project_id=$2 AND source_type=$3 AND source_id=$4`,values:[generationId,event.project_id,event.source_type,event.source_id]});
      }else{
        const d=event.payload;
        if(d.project_id!==event.project_id||d.tenant_id!==event.tenant_id) throw new Error('search event scope mismatch');
        await this.pool.query({text:`INSERT INTO forge_search_generation_documents(generation_id,project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,indexed_at)
          VALUES($1,$2,$3,$4,$5,$6,left(coalesce($7,''),2048),left(coalesce($8,''),16000),$9,$10,$11,$12,$13,$14,$15,setweight(to_tsvector('simple',left(coalesce($7,''),2048)),'A')||setweight(to_tsvector('simple',left(coalesce($8,''),16000)),'B')||setweight(to_tsvector('simple',$4||' '||$5),'C'),coalesce($16,'{}'::jsonb),now())
          ON CONFLICT(generation_id,project_id,source_type,source_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,episode_id=EXCLUDED.episode_id,title=EXCLUDED.title,content=EXCLUDED.content,state=EXCLUDED.state,stage=EXCLUDED.stage,provider=EXCLUDED.provider,artifact_kind=EXCLUDED.artifact_kind,occurred_at=EXCLUDED.occurred_at,source_updated_at=EXCLUDED.source_updated_at,source_fingerprint=EXCLUDED.source_fingerprint,search_vector=EXCLUDED.search_vector,metadata=EXCLUDED.metadata,indexed_at=now()`,values:[generationId,d.project_id,d.tenant_id,d.source_type,d.source_id,d.episode_id,d.title,d.content,d.state,d.stage,d.provider,d.artifact_kind,d.occurred_at,d.source_updated_at,d.source_fingerprint,d.metadata]});
      }
    }
    await this.pool.query({text:`UPDATE forge_search_index_generations SET last_applied_event_id=GREATEST(last_applied_event_id,$2),duplicate_events=duplicate_events+$3,out_of_order_events=out_of_order_events+$4,updated_at=now() WHERE generation_id=$1`,values:[generationId,last,duplicate,outOfOrder]});
    return {lastEventId:last,duplicateEvents:duplicate,outOfOrderEvents:outOfOrder,eventCount:events.rows.length};
  }

  async verifyAndCutover({tenantId,actor,generationId}){
    const g=await this.getGeneration({tenantId,generationId});
    await this.pool.query({text:`UPDATE forge_search_index_generations SET state='VERIFYING',updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`,values:[generationId]});
    const latest=await this.pool.query({text:`SELECT coalesce(max(event_id),0)::bigint event_id FROM forge_search_index_events WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:[tenantId,g.project_id]});
    const through=Number(latest.rows[0]?.event_id||0);
    await this.replayEvents({tenantId,generationId,afterEventId:Number(g.start_event_id||0),throughEventId:through});
    const verify=await this.verifyGeneration({tenantId,projectId:g.project_id,generationId});
    if(!verify.ok){
      const e=new Error(`search generation verification failed: ${JSON.stringify(verify.failures)}`);e.code='SEARCH_GENERATION_VERIFY_FAILED';throw e;
    }
    await this.cutover({tenantId,actor,generationId,throughEventId:through});
    return this.getGeneration({tenantId,generationId});
  }

  async verifyGeneration({tenantId,projectId=null,generationId=null}){
    const generation=generationId?await this.getGeneration({tenantId,generationId}):null;
    const genId=generation?.generation_id;
    const indexedSql=genId
      ? `SELECT count(*)::bigint count,count(*) FILTER (WHERE tenant_id<>$1)::bigint cross_tenant FROM forge_search_generation_documents WHERE generation_id=$2 AND tenant_id=$1 AND ($3::text IS NULL OR project_id=$3)`
      : `SELECT count(*)::bigint count,count(*) FILTER (WHERE tenant_id<>$1)::bigint cross_tenant FROM forge_search_documents WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`;
    const indexed=await this.pool.query({text:indexedSql,values:genId?[tenantId,genId,projectId]:[tenantId,projectId]});
    const expected=await this.pool.query({text:`SELECT count(*)::bigint count FROM (${SOURCE_SQL.replace(/\nSELECT \* FROM source_rows[\s\S]*?LIMIT \$5$/,'SELECT * FROM source_rows')}) q`,values:[tenantId,projectId,null,'',Number.MAX_SAFE_INTEGER]});
    const indexedCount=Number(indexed.rows[0]?.count||0); const expectedCount=Number(expected.rows[0]?.count||0); const crossTenant=Number(indexed.rows[0]?.cross_tenant||0);
    const duplicate=genId
      ? await this.pool.query({text:`SELECT count(*)::bigint duplicate_count FROM (SELECT project_id,source_type,source_id,count(*) c FROM forge_search_generation_documents WHERE generation_id=$1 GROUP BY 1,2,3 HAVING count(*)>1) d`,values:[genId]})
      : await this.pool.query({text:`SELECT count(*)::bigint duplicate_count FROM (SELECT project_id,source_type,source_id,count(*) c FROM forge_search_documents GROUP BY 1,2,3 HAVING count(*)>1) d`});
    const failures=[]; if(indexedCount!==expectedCount) failures.push({kind:'COUNT_MISMATCH',expected:expectedCount,indexed:indexedCount}); if(crossTenant) failures.push({kind:'TENANT_SCOPE',count:crossTenant}); if(Number(duplicate.rows[0]?.duplicate_count||0)) failures.push({kind:'DUPLICATE_IDENTITY',count:Number(duplicate.rows[0].duplicate_count)});
    return {ok:failures.length===0,expectedCount,indexedCount,crossTenantCount:crossTenant,failures,generationId:genId||null};
  }

  async cutover({tenantId,actor,generationId,throughEventId}){
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('forge-search-cutover',0))`);
      const current=await client.query({text:`SELECT * FROM forge_search_index_meta WHERE singleton=true FOR UPDATE`});
      const currentMeta=current.rows[0];
      await client.query('LOCK TABLE forge_search_documents IN ACCESS EXCLUSIVE MODE');
      await client.query({text:`DELETE FROM forge_search_documents WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:[tenantId,(await this.getGeneration({tenantId,generationId})).project_id]});
      const projectId=(await this.getGeneration({tenantId,generationId})).project_id;
      await client.query({text:`INSERT INTO forge_search_documents(project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,indexed_at)
        SELECT project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,now() FROM forge_search_generation_documents WHERE generation_id=$1 AND tenant_id=$2 AND ($3::text IS NULL OR project_id=$3)`,values:[generationId,tenantId,projectId]});
      await client.query({text:`UPDATE forge_search_index_generations SET state='ACTIVE',activated_at=now(),last_applied_event_id=$2,updated_at=now() WHERE generation_id=$1`,values:[generationId,throughEventId]});
      await client.query({text:`UPDATE forge_search_index_generations SET state='RETIRED',retired_at=now(),updated_at=now() WHERE tenant_id=$1 AND generation_id<>$2 AND state='ACTIVE' AND ($3::text IS NULL OR project_id=$3)`,values:[tenantId,generationId,projectId]});
      await client.query({text:`UPDATE forge_search_index_meta SET active_generation=$1,generation_epoch=generation_epoch+1,last_applied_event_id=$2,state='READY',failure_state=NULL,last_verified_at=now(),updated_at=now() WHERE singleton=true`,values:[generationId,throughEventId]});
      await client.query('COMMIT');
      return currentMeta;
    }catch(error){try{await client.query('ROLLBACK');}catch{};throw error;}finally{client.release();}
  }

  async reconcile({tenantId,projectId=null,limit=MAX_REPAIR}){
    const bounded=boundedInt(limit,MAX_REPAIR,MAX_REPAIR);
    const meta=await this.pool.query('SELECT last_applied_event_id FROM forge_search_index_meta WHERE singleton=true');
    let cursor=Number(meta.rows[0]?.last_applied_event_id||0);
    const events=await this.pool.query({text:`SELECT * FROM forge_search_index_events WHERE tenant_id=$1 AND event_id>$2 AND ($3::text IS NULL OR project_id=$3) ORDER BY event_id LIMIT $4`,values:[tenantId,cursor,projectId,bounded]});
    let applied=0,duplicates=0,outOfOrder=0;
    for(const event of events.rows){
      if(Number(event.event_id)<=cursor){outOfOrder++;continue;}
      cursor=Number(event.event_id);
      if(event.operation==='DELETE'){
        await this.pool.query({text:`DELETE FROM forge_search_documents WHERE tenant_id=$1 AND project_id=$2 AND source_type=$3 AND source_id=$4`,values:[tenantId,event.project_id,event.source_type,event.source_id]});
      }else{
        const d=event.payload;
        if(d.tenant_id!==tenantId||d.project_id!==event.project_id) throw new Error('search repair tenant/project mismatch');
        await this.pool.query({text:`SELECT forge_search_refresh_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,values:[d.project_id,d.tenant_id,d.source_type,d.source_id,d.episode_id,d.title,d.content,d.state,d.stage,d.provider,d.artifact_kind,d.occurred_at,d.source_updated_at,d.metadata]});
      }
      applied++;
    }
    await this.pool.query({text:`UPDATE forge_search_index_meta SET last_applied_event_id=GREATEST(last_applied_event_id,$1),last_reconciled_at=now(),last_reconcile_drift=$2,updated_at=now() WHERE singleton=true`,values:[cursor,Math.max(0,events.rows.length-applied)]});
    return {scanned:events.rows.length,applied,duplicates,outOfOrder,lastAppliedEventId:cursor,moreAvailable:events.rows.length===bounded};
  }

  async repair({tenantId,projectId=null,limit=MAX_REPAIR}){
    const result=await this.reconcile({tenantId,projectId,limit});
    const verification=await this.verifyGeneration({tenantId,projectId});
    return {...result,verification};
  }

  async lag({tenantId,projectId=null}){
    const r=await this.pool.query({text:`SELECT coalesce(max(e.event_id),0)::bigint latest_event_id,(SELECT last_applied_event_id FROM forge_search_index_meta WHERE singleton=true)::bigint last_applied_event_id FROM forge_search_index_events e WHERE e.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2)`,values:[tenantId,projectId]});
    const latest=Number(r.rows[0]?.latest_event_id||0);const applied=Number(r.rows[0]?.last_applied_event_id||0);return {latestEventId:latest,lastAppliedEventId:applied,lag:Math.max(0,latest-applied)};
  }
}

module.exports = { SearchIndexConsistencyService, SOURCE_SQL, SCHEMA_VERSION };
