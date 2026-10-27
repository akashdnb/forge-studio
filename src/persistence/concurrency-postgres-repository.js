const { PostgresRepository } = require('./postgres-repository');
const { assertSameEpisode, provenanceConflict, stateConflict } = require('./concurrency');
function sameJson(a,b){return JSON.stringify(a??{})===JSON.stringify(b??{});}
class ConcurrencyPostgresRepository extends PostgresRepository {
  async appendVersion(input){return this.withTransaction(async(client)=>{
    const episode=await client.query('SELECT id FROM episodes WHERE id=$1 FOR UPDATE',[input.episodeId]);
    if(!episode.rows[0]) throw Object.assign(new Error('Unknown episode'),{code:'NOT_FOUND'});
    const existing=await client.query('SELECT * FROM version_records WHERE id=$1 FOR SHARE',[input.id]);
    if(existing.rows[0]){
      assertSameEpisode(existing.rows[0].episode_id,input.episodeId,'Version belongs to a different episode');
      if(existing.rows[0].kind!==input.kind||existing.rows[0].parent_id!==(input.parentId||null)||existing.rows[0].content_hash!==(input.contentHash||null)||!sameJson(existing.rows[0].payload,input.payload||{})) throw stateConflict('Version id was reused with different immutable content',{versionId:input.id});
      await client.query(`INSERT INTO forge_concurrency_events(event_type,episode_id,version_id,actor,details) VALUES('IDEMPOTENT_REPLAY',$1,$2,$3,$4::jsonb)`,[input.episodeId,input.id,input.createdBy||'system',JSON.stringify({operation:'appendVersion'})]);
      return existing.rows[0];
    }
    const dependencyIds=[...new Set([...(input.dependencies||[]),...(input.parentId?[input.parentId]:[])])];
    for(const dependencyId of dependencyIds){const dependency=await client.query('SELECT episode_id FROM version_records WHERE id=$1 FOR SHARE',[dependencyId]);if(!dependency.rows[0]) throw Object.assign(new Error('Unknown version dependency'),{code:'INVALID_DEPENDENCY'});assertSameEpisode(dependency.rows[0].episode_id,input.episodeId,'Cross-episode version dependency');}
    const inserted=await client.query(`INSERT INTO version_records(id,episode_id,kind,parent_id,payload,content_hash,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,[input.id,input.episodeId,input.kind,input.parentId||null,JSON.stringify(input.payload||{}),input.contentHash||null,input.createdBy||'system']);
    for(const dependencyId of dependencyIds) await client.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.episodeId,input.id,dependencyId]);
    return inserted.rows[0];
  });}
  async registerArtifact(input){
    const existing=await this.pool.query('SELECT * FROM artifacts WHERE id=$1',[input.id]);
    if(existing.rows[0]){assertSameEpisode(existing.rows[0].episode_id,input.episodeId,'Artifact belongs to a different episode');if(existing.rows[0].version_id!==input.versionId||existing.rows[0].kind!==input.kind) throw provenanceConflict('Artifact id was reused with different provenance',{artifactId:input.id});return existing.rows[0];}
    const inputVersionIds=[...new Set(input.inputVersionIds||[])];
    for(const versionId of inputVersionIds){const version=await this.pool.query('SELECT episode_id FROM version_records WHERE id=$1',[versionId]);if(!version.rows[0]) throw provenanceConflict(`Artifact input version not found: ${versionId}`);assertSameEpisode(version.rows[0].episode_id,input.episodeId,'Artifact input version belongs to a different episode');}
    if(input.providerRunId){const run=await this.pool.query('SELECT episode_id FROM provider_runs WHERE id=$1',[input.providerRunId]);if(!run.rows[0]) throw Object.assign(new Error('Provider run not found'),{code:'NOT_FOUND'});assertSameEpisode(run.rows[0].episode_id,input.episodeId,'Artifact provider run belongs to a different episode');}
    try{return await super.registerArtifact({...input,inputVersionIds});}catch(error){if(error?.code==='23505'){const raced=await this.pool.query('SELECT * FROM artifacts WHERE id=$1',[input.id]);if(raced.rows[0]){assertSameEpisode(raced.rows[0].episode_id,input.episodeId,'Artifact belongs to a different episode');return raced.rows[0];}}throw error;}
  }
  async recordQa(input){
    const key=input.idempotencyKey||input.id;const existing=await this.pool.query('SELECT * FROM qa_results WHERE idempotency_key=$1',[key]);if(existing.rows[0]) return existing.rows[0];
    const artifact=await this.pool.query('SELECT episode_id,version_id FROM artifacts WHERE id=$1',[input.artifactId]);if(!artifact.rows[0]) throw Object.assign(new Error('Unknown artifact'),{code:'NOT_FOUND'});assertSameEpisode(artifact.rows[0].episode_id,input.episodeId,'QA artifact belongs to a different episode');if(artifact.rows[0].version_id!==input.versionId) throw provenanceConflict('QA version does not match artifact');
    try{return await this.withTransaction(async(client)=>{const result=await client.query(`INSERT INTO qa_results(id,episode_id,artifact_id,version_id,status,checks,runner,metadata,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9) RETURNING *`,[input.id,input.episodeId,input.artifactId,input.versionId,input.status,JSON.stringify(input.checks||[]),input.runner||'forge-core',JSON.stringify(input.metadata||{}),key]);return result.rows[0];});}catch(error){if(error?.code==='23505'){const raced=await this.pool.query('SELECT * FROM qa_results WHERE idempotency_key=$1',[key]);if(raced.rows[0]) return raced.rows[0];}throw error;}
  }
}
module.exports={ConcurrencyPostgresRepository};
