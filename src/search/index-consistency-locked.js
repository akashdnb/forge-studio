const { JsonSafeSearchIndexConsistencyService } = require('./index-consistency-json-safe');

class LockedSearchIndexConsistencyService extends JsonSafeSearchIndexConsistencyService {
  async runBatch(args) {
    const lock = await this.pool.query({ text: `SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked`, values: [args.generationId] });
    if (!lock.rows[0]?.locked) return this.getGeneration({ tenantId: args.tenantId, generationId: args.generationId });
    try { return await super.runBatch(args); }
    finally { await this.pool.query({ text: `SELECT pg_advisory_unlock(hashtextextended($1,0))`, values: [args.generationId] }).catch(() => {}); }
  }
}

module.exports = { LockedSearchIndexConsistencyService };
