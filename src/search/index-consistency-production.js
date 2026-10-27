const { SafeSearchIndexConsistencyService } = require('./index-consistency-safe');

class ProductionSearchIndexConsistencyService extends SafeSearchIndexConsistencyService {
  async runBatch({ tenantId, actor, generationId }) {
    const lease = await this.pool.query({ text: `SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked`, values: [generationId] });
    if (!lease.rows[0]?.locked) return this.getGeneration({ tenantId, generationId });
    try {
      const g = await this.getGeneration({ tenantId, generationId });
      if (g.state === 'ACTIVE' || g.state === 'FAILED') return g;
      if (this.failureInjector) await this.failureInjector({ point: 'before_batch', generation: g });

      const sourceIndex = Math.max(0, require('./index-consistency-safe').SOURCES.findIndex(([type]) => type === g.checkpoint_type));
      const [sourceType, table] = require('./index-consistency-safe').SOURCES[sourceIndex];
      const cursor = g.checkpoint_type === sourceType ? g.checkpoint_id : '';
      const projectExpr = sourceType === 'project' ? 't.id::text' : `forge_search_source_project_id(to_jsonb(t),NULLIF(to_jsonb(t)->>'episode_id',''))`;
      const source = await this.pool.query({ text: `SELECT to_jsonb(t) AS row FROM ${table} t WHERE forge_search_source_tenant_id(${projectExpr})=$1 AND ($2::text IS NULL OR ${projectExpr}=$2) AND t.id::text>$3 ORDER BY t.id::text LIMIT $4`, values: [tenantId, g.project_id, cursor, this.batchSize] });

      if (!source.rows.length) {
        const next = require('./index-consistency-safe').SOURCES[sourceIndex + 1];
        if (next) {
          await this.pool.query({ text: `UPDATE forge_search_index_generations SET checkpoint_type=$2,checkpoint_id='',updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`, values: [generationId, next[0]] });
          return this.getGeneration({ tenantId, generationId });
        }
        return this.verifyAndCutover({ tenantId, actor, generationId });
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of source.rows) {
          const r = item.row;
          if (this.failureInjector) await this.failureInjector({ point: 'before_row', generation: g, row: r });
          const episodeId = r.episode_id == null ? null : String(r.episode_id);
          let projectId = sourceType === 'project' ? String(r.id) : (await client.query({ text: 'SELECT forge_search_source_project_id($1::jsonb,$2) project_id', values: [JSON.stringify(r), episodeId] })).rows[0]?.project_id;
          if (!projectId) continue;
          const tenant = await client.query({ text: 'SELECT forge_search_source_tenant_id($1) tenant_id', values: [projectId] });
          if (tenant.rows[0]?.tenant_id !== tenantId) continue;
          let title='', content='', metadata=r.metadata || {}, artifactKind=r.kind || null;
          if (sourceType==='project') { title=String(r.name||''); content=JSON.stringify(r.metadata||{}); }
          else if (sourceType==='episode') { title=String(r.title||''); content=`${r.description||''} ${r.state||''}`; }
          else if (sourceType==='version') { title=`${r.kind||''} ${r.id||''}`; content=JSON.stringify(r.payload||{}); metadata=r.payload||{}; }
          else if (sourceType==='artifact') { title=`${r.kind||''} ${r.media_type||''}`; content=`${r.content_hash||''} ${r.source||''}`; }
          else if (sourceType==='job') { title=`${r.kind||''} ${r.status||''}`; content=`${r.worker_id||''} ${JSON.stringify(r.error||{})} ${JSON.stringify(r.result||{})}`; metadata={priority:r.priority,attempts:r.attempts,maxAttempts:r.max_attempts}; }
          else if (sourceType==='provider_run') { title=`${r.capability||''} ${r.provider||''} ${r.model||''}`; content=`${r.external_job_id||''} ${JSON.stringify(r.error||{})}`; metadata={attempt:r.attempt,idempotencyKey:r.idempotency_key}; }
          else if (sourceType==='approval') { title=`${r.stage||''} ${r.decision||''}`; content=`${r.actor||''} ${r.comments||''}`; metadata=r.evidence||{}; }
          else if (sourceType==='qa') { title=`${r.status||''} ${r.runner||''}`; content=JSON.stringify(r.checks||[]); }
          else if (sourceType==='publish_run') { title=`${r.destination||''} ${r.status||''}`; content=`${r.external_id||''} ${r.external_url||''}`; }
          else if (sourceType==='cost') { title=`${r.provider||''} ${r.operation||''}`; content=`${r.model||''} ${r.currency||''}`; }
          else if (sourceType==='audit_event') { title=`${r.action||''} ${r.target_type||''}`; content=`${r.actor||''} ${r.target_id||''}`; metadata=r.details||{}; }
          else { title=String(r.id||''); content=JSON.stringify(r); }
          const occurred=r.created_at || new Date().toISOString();
          const updated=r.updated_at || occurred;
          await this.upsertGenerationRowOn(client,generationId,{project_id:projectId,tenant_id:tenantId,source_type:sourceType,source_id:String(r.id),episode_id:episodeId,title,content,state:r.state||null,stage:r.stage||null,provider:r.provider||null,artifact_kind:artifactKind,occurred_at:occurred,source_updated_at:updated,metadata});
        }
        const last=String(source.rows[source.rows.length-1].row.id);
        await client.query({ text: `UPDATE forge_search_index_generations SET checkpoint_type=$2,checkpoint_id=$3,processed=processed+$4,updated_at=now() WHERE generation_id=$1 AND state='BUILDING'`, values: [generationId,sourceType,last,source.rows.length] });
        await client.query('COMMIT');
      } catch(error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally { client.release(); }
      return this.getGeneration({ tenantId, generationId });
    } catch(error) {
      await this.pool.query({ text: `UPDATE forge_search_index_generations SET state='FAILED',failure_state='BUILD_ERROR',failure_detail=$2,updated_at=now() WHERE generation_id=$1`, values: [generationId,String(error.stack||error).slice(0,8000)] }).catch(()=>{});
      await this.pool.query({ text: `UPDATE forge_search_index_meta SET state='DEGRADED',failure_state=$1,updated_at=now() WHERE singleton=true`, values: [String(error.message||error).slice(0,2000)] }).catch(()=>{});
      throw error;
    } finally {
      await this.pool.query({ text: `SELECT pg_advisory_unlock(hashtextextended($1,0))`, values: [generationId] }).catch(()=>{});
    }
  }

  async upsertGenerationRowOn(client,generationId,row){
    const fp=(await client.query({text:`SELECT forge_search_document_fingerprint($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) fingerprint`,values:[row.project_id,row.tenant_id,row.source_type,row.source_id,row.episode_id,row.title,row.content,row.state,row.stage,row.provider,row.artifact_kind,row.occurred_at,row.source_updated_at,row.metadata]})).rows[0].fingerprint;
    await client.query({text:`INSERT INTO forge_search_generation_documents(generation_id,project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,indexed_at)
      VALUES($1,$2,$3,$4,$5,$6,left(coalesce($7,''),2048),left(coalesce($8,''),16000),$9,$10,$11,$12,$13,$14,$15,setweight(to_tsvector('simple',left(coalesce($7,''),2048)),'A')||setweight(to_tsvector('simple',left(coalesce($8,''),16000)),'B')||setweight(to_tsvector('simple',$4||' '||$5),'C'),coalesce($16,'{}'::jsonb),now())
      ON CONFLICT(generation_id,project_id,source_type,source_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,episode_id=EXCLUDED.episode_id,title=EXCLUDED.title,content=EXCLUDED.content,state=EXCLUDED.state,stage=EXCLUDED.stage,provider=EXCLUDED.provider,artifact_kind=EXCLUDED.artifact_kind,occurred_at=EXCLUDED.occurred_at,source_updated_at=EXCLUDED.source_updated_at,source_fingerprint=EXCLUDED.source_fingerprint,search_vector=EXCLUDED.search_vector,metadata=EXCLUDED.metadata,indexed_at=now()`,values:[generationId,row.project_id,row.tenant_id,row.source_type,row.source_id,row.episode_id,row.title,row.content,row.state,row.stage,row.provider,row.artifact_kind,row.occurred_at,row.source_updated_at,fp,row.metadata]});
  }
}

module.exports={ProductionSearchIndexConsistencyService};
