const { ProductionSearchIndexConsistencyService } = require('./index-consistency-production');

class ScopedSearchIndexConsistencyService extends ProductionSearchIndexConsistencyService {
  async scopeState(tenantId, projectId) {
    const exact = projectId ? await this.pool.query({ text: `SELECT * FROM forge_search_index_active_scopes WHERE tenant_id=$1 AND project_id=$2`, values: [tenantId,projectId] }) : { rows: [] };
    if (exact.rows[0]) return exact.rows[0];
    const tenant = await this.pool.query({ text: `SELECT * FROM forge_search_index_active_scopes WHERE tenant_id=$1 AND project_id IS NULL`, values: [tenantId] });
    return tenant.rows[0] || null;
  }

  async health({ tenantId, projectId=null }) {
    const [base,scope,events]=await Promise.all([
      super.health({tenantId,projectId}),
      this.scopeState(tenantId,projectId),
      this.pool.query({text:`SELECT coalesce(max(event_id),0)::bigint latest_event_id FROM forge_search_index_events WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:[tenantId,projectId]}),
    ]);
    const latest=Number(events.rows[0]?.latest_event_id||0); const applied=Number(scope?.last_applied_event_id||0);
    return {...base,activeGeneration:scope?.active_generation_id||base.activeGeneration,generationEpoch:Number(scope?.generation_epoch||base.generationEpoch),lastAppliedEventId:applied,latestEventId:latest,lag:Math.max(0,latest-applied),lastVerifiedAt:scope?.last_verified_at||base.lastVerifiedAt,failureState:scope?.failure_state||base.failureState};
  }

  async lag({tenantId,projectId=null}) {
    const scope=await this.scopeState(tenantId,projectId);
    const latest=await this.pool.query({text:`SELECT coalesce(max(event_id),0)::bigint event_id FROM forge_search_index_events WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)`,values:[tenantId,projectId]});
    const latestId=Number(latest.rows[0]?.event_id||0);const applied=Number(scope?.last_applied_event_id||0);
    return {latestEventId:latestId,lastAppliedEventId:applied,lag:Math.max(0,latestId-applied),activeGenerationId:scope?.active_generation_id||null};
  }

  async reconcile({tenantId,projectId=null,limit=500}) {
    const bounded=Math.max(1,Math.min(Number(limit)||500,500));
    const scope=await this.scopeState(tenantId,projectId);
    if(!scope) return {scanned:0,applied:0,duplicates:0,outOfOrder:0,lastAppliedEventId:0,moreAvailable:false};
    let cursor=Number(scope.last_applied_event_id||0); let applied=0,duplicates=0,outOfOrder=0;
    const events=await this.pool.query({text:`SELECT * FROM forge_search_index_events WHERE tenant_id=$1 AND event_id>$2 AND ($3::text IS NULL OR project_id=$3) ORDER BY event_id LIMIT $4`,values:[tenantId,cursor,projectId,bounded]});
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      for(const event of events.rows){
        if(Number(event.event_id)<=cursor){outOfOrder++;continue;}
        cursor=Number(event.event_id);
        const active=await client.query({text:`SELECT active_generation_id FROM forge_search_index_active_scopes WHERE tenant_id=$1 AND ((project_id=$2) OR (project_id IS NULL AND $2::text IS NULL)) FOR UPDATE`,values:[tenantId,projectId]});
        const generationId=active.rows[0]?.active_generation_id;
        if(generationId){
          const app=await client.query({text:`INSERT INTO forge_search_index_event_applications(generation_id,event_id,outcome) VALUES($1,$2,'APPLIED') ON CONFLICT DO NOTHING RETURNING event_id`,values:[generationId,event.event_id]});
          if(!app.rowCount){duplicates++;continue;}
        }
        if(event.operation==='DELETE'){
          await client.query({text:`DELETE FROM forge_search_documents WHERE tenant_id=$1 AND project_id=$2 AND source_type=$3 AND source_id=$4`,values:[tenantId,event.project_id,event.source_type,event.source_id]});
        }else{
          const d=event.payload;
          if(d.tenant_id!==tenantId||d.project_id!==event.project_id) throw new Error('search repair tenant/project mismatch');
          await client.query({text:`SELECT forge_search_refresh_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,values:[d.project_id,d.tenant_id,d.source_type,d.source_id,d.episode_id,d.title,d.content,d.state,d.stage,d.provider,d.artifact_kind,d.occurred_at,d.source_updated_at,d.metadata]});
        }
        applied++;
      }
      await client.query({text:`UPDATE forge_search_index_active_scopes SET last_applied_event_id=GREATEST(last_applied_event_id,$3),last_verified_at=now(),updated_at=now() WHERE tenant_id=$1 AND ((project_id=$2) OR (project_id IS NULL AND $2::text IS NULL))`,values:[tenantId,projectId,cursor]});
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
    return {scanned:events.rows.length,applied,duplicates,outOfOrder,lastAppliedEventId:cursor,moreAvailable:events.rows.length===bounded};
  }
}

module.exports={ScopedSearchIndexConsistencyService};
