const { SearchIndexConsistencyService: Base, SCHEMA_VERSION } = require('./index-consistency');

const SOURCES = [
  ['project','projects'],['episode','episodes'],['version','version_records'],['artifact','artifacts'],
  ['job','forge_jobs'],['provider_run','provider_runs'],['approval','approvals'],['qa','qa_results'],
  ['publish_run','publish_runs'],['cost','cost_records'],['audit_event','audit_events'],['usage','usage_events'],['budget','usage_budgets'],
];

function text(v, fallback='') { return v == null ? fallback : String(v); }
function json(v, fallback={}) { return v == null ? fallback : v; }
function time(v, fallback='now()') { return v ? v : fallback; }

class SafeSearchIndexConsistencyService extends Base {
  async runBatch({ tenantId, actor, generationId }) {
    const g=await this.getGeneration({tenantId,generationId});
    if(g.state==='ACTIVE'||g.state==='FAILED') return g;
    try {
      if(this.failureInjector) await this.failureInjector({point:'before_batch',generation:g});
      let sourceIndex=SOURCES.findIndex(([type])=>type===g.checkpoint_type);
      if(sourceIndex<0) sourceIndex=0;
      const [sourceType,table]=SOURCES[sourceIndex];
      const cursor=g.checkpoint_type===sourceType ? g.checkpoint_id : '';
      const projectExpr=sourceType==='project' ? 't.id::text' : `forge_search_source_project_id(to_jsonb(t),NULLIF(to_jsonb(t)->>'episode_id',''))`;
      const sql=`SELECT to_jsonb(t) AS row FROM ${table} t WHERE forge_search_source_tenant_id(${projectExpr})= $1 AND ($2::text IS NULL OR ${projectExpr}=$2) AND t.id::text>$3 ORDER BY t.id::text LIMIT $4`;
      const rows=await this.pool.query({text:sql,values:[tenantId,g.project_id,cursor,this.batchSize]});
      if(rows.rows.length===0){
        const next=SOURCES[sourceIndex+1];
        if(next){
          await this.pool.query({text:`UPDATE forge_search_index_generations SET checkpoint_type=$2,checkpoint_id='',updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`,values:[generationId,next[0]]});
          return this.getGeneration({tenantId,generationId});
        }
        return this.verifyAndCutover({tenantId,actor,generationId});
      }
      await this.pool.query('BEGIN');
      try {
        for(const item of rows.rows){
          const r=item.row;
          if(this.failureInjector) await this.failureInjector({point:'before_row',generation:g,row:r});
          const episodeId=r.episode_id ? text(r.episode_id) : null;
          let projectId=sourceType==='project' ? text(r.id) : await this.pool.query({text:'SELECT forge_search_source_project_id($1,$2) project_id',values:[r,episodeId]}).then(x=>x.rows[0]?.project_id||null);
          if(!projectId) continue;
          const tenant=await this.pool.query({text:'SELECT forge_search_source_tenant_id($1) tenant_id',values:[projectId]});
          if(tenant.rows[0]?.tenant_id!==tenantId) continue;
          let title='',content='',metadata=json(r.metadata,{}),artifactKind=r.kind||null;
          if(sourceType==='project'){title=text(r.name);content=JSON.stringify(json(r.metadata,{}));}
          else if(sourceType==='episode'){title=text(r.title);content=`${text(r.description)} ${text(r.state)}`;}
          else if(sourceType==='version'){title=`${text(r.kind)} ${text(r.id)}`;content=JSON.stringify(json(r.payload,{}));metadata=json(r.payload,{});}
          else if(sourceType==='artifact'){title=`${text(r.kind)} ${text(r.media_type)}`;content=`${text(r.content_hash)} ${text(r.source)}`;}
          else if(sourceType==='job'){title=`${text(r.kind)} ${text(r.status)}`;content=`${text(r.worker_id)} ${JSON.stringify(json(r.error,{}))} ${JSON.stringify(json(r.result,{}))}`;metadata={priority:r.priority,attempts:r.attempts,maxAttempts:r.max_attempts};}
          else if(sourceType==='provider_run'){title=`${text(r.capability)} ${text(r.provider)} ${text(r.model)}`;content=`${text(r.external_job_id)} ${JSON.stringify(json(r.error,{}))}`;metadata={attempt:r.attempt,idempotencyKey:r.idempotency_key};}
          else if(sourceType==='approval'){title=`${text(r.stage)} ${text(r.decision)}`;content=`${text(r.actor)} ${text(r.comments)}`;metadata=json(r.evidence,{});}
          else if(sourceType==='qa'){title=`${text(r.status)} ${text(r.runner)}`;content=JSON.stringify(json(r.checks,[]));}
          else if(sourceType==='publish_run'){title=`${text(r.destination)} ${text(r.status)}`;content=`${text(r.external_id)} ${text(r.external_url)}`;}
          else if(sourceType==='cost'){title=`${text(r.provider)} ${text(r.operation)}`;content=`${text(r.model)} ${text(r.currency)}`;}
          else if(sourceType==='audit_event'){title=`${text(r.action)} ${text(r.target_type)}`;content=`${text(r.actor)} ${text(r.target_id)}`;metadata=json(r.details,{});}
          else {title=text(r.id);content=JSON.stringify(r);}
          const occurred=time(r.created_at,new Date().toISOString());
          const updated=time(r.updated_at,occurred);
          await this.upsertGenerationRow(generationId,{project_id:projectId,tenant_id:tenantId,source_type:sourceType,source_id:text(r.id),episode_id:episodeId,title,content,state:r.state||null,stage:r.stage||null,provider:r.provider||null,artifact_kind:artifactKind,occurred_at:occurred,source_updated_at:updated,metadata});
        }
        const last=rows.rows[rows.rows.length-1].row.id;
        await this.pool.query({text:`UPDATE forge_search_index_generations SET checkpoint_type=$2,checkpoint_id=$3,processed=processed+$4,updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`,values:[generationId,sourceType,text(last),rows.rows.length]});
        await this.pool.query('COMMIT');
      } catch(error){await this.pool.query('ROLLBACK');throw error;}
      return this.getGeneration({tenantId,generationId});
    } catch(error){
      await this.pool.query({text:`UPDATE forge_search_index_generations SET state='FAILED',failure_state='BUILD_ERROR',failure_detail=$2,updated_at=now() WHERE generation_id=$1`,values:[generationId,String(error.stack||error).slice(0,8000)]}).catch(()=>{});
      await this.pool.query({text:`UPDATE forge_search_index_meta SET state='DEGRADED',failure_state=$1,updated_at=now() WHERE singleton=true`,values:[String(error.message||error).slice(0,2000)]}).catch(()=>{});
      throw error;
    }
  }

  async verifyGeneration({tenantId,projectId=null,generationId=null}) {
    const generation=generationId?await this.getGeneration({tenantId,generationId}):null;
    const indexed=await this.pool.query({text:generation
      ? `SELECT count(*)::bigint count,count(*) FILTER (WHERE tenant_id<>$1)::bigint cross_tenant,count(DISTINCT (project_id,source_type,source_id))::bigint identities FROM forge_search_generation_documents WHERE generation_id=$2 AND tenant_id=$1 AND ($3::text IS NULL OR project_id=$3)`
      : `SELECT count(*)::bigint count,count(*) FILTER (WHERE tenant_id<>$1)::bigint cross_tenant,count(DISTINCT (project_id,source_type,source_id))::bigint identities FROM forge_search_documents WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,
      values:generation?[tenantId,generationId,projectId]:[tenantId,projectId]});
    let expected=0;
    let sourceErrors=[];
    for(const [sourceType,table] of SOURCES){
      try{
        const projectExpr=sourceType==='project' ? 't.id::text' : `forge_search_source_project_id(to_jsonb(t),NULLIF(to_jsonb(t)->>'episode_id',''))`;
        const r=await this.pool.query({text:`SELECT count(*)::bigint count FROM ${table} t WHERE forge_search_source_tenant_id(${projectExpr})= $1 AND ($2::text IS NULL OR ${projectExpr}=$2)`,values:[tenantId,projectId]});
        expected+=Number(r.rows[0]?.count||0);
      }catch(error){sourceErrors.push({sourceType,error:String(error.message||error)});}
    }
    const row=indexed.rows[0]||{};const indexedCount=Number(row.count||0);const identities=Number(row.identities||0);const crossTenant=Number(row.cross_tenant||0);
    const failures=[];if(sourceErrors.length) failures.push({kind:'SOURCE_SCAN_ERROR',sources:sourceErrors});if(indexedCount!==expected) failures.push({kind:'COUNT_MISMATCH',expected,indexed:indexedCount});if(identities!==indexedCount) failures.push({kind:'DUPLICATE_IDENTITY',indexed:indexedCount,identities});if(crossTenant) failures.push({kind:'TENANT_SCOPE',count:crossTenant});
    return {ok:failures.length===0,expectedCount:expected,indexedCount,identityCount:identities,crossTenantCount:crossTenant,failures,generationId:generationId||null,schemaVersion:SCHEMA_VERSION};
  }
}

module.exports={SafeSearchIndexConsistencyService,SOURCES};
