const { randomUUID } = require('node:crypto');
class DurableReviewEvents {
  constructor({ pool } = {}) { if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required'); this.pool=pool; }
  async publish({ client=this.pool, tenantId, projectId, episodeId=null, type, payload, aggregateType='review', aggregateId=null }) {
    if (!tenantId || !projectId || !type) throw new TypeError('tenantId, projectId and type are required');
    const eventId=randomUUID();
    const schema={version:1,required:Object.keys(payload||{}).filter(k=>['threadId','commentId','decisionId','episodeId','projectId','versionId','state','decision'].includes(k))};
    const event=(await client.query(`INSERT INTO forge_events(id,tenant_id,project_id,episode_id,type,version,schema,payload,aggregate_type,aggregate_id,provenance)
      VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb) RETURNING *`,[eventId,tenantId,projectId,episodeId,type,JSON.stringify(schema),JSON.stringify(payload),aggregateType,aggregateId,JSON.stringify({subsystem:'editorial-review'})])).rows[0];
    await client.query('INSERT INTO forge_outbox(topic,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4::jsonb)',['event.created','forge_event',eventId,JSON.stringify({eventId})]);
    return event;
  }
}
module.exports={DurableReviewEvents};
