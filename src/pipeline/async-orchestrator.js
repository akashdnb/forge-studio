const { randomUUID } = require('node:crypto');
const { WORKFLOW_DEPENDENCIES } = require('./workflow');

const ORDER = ['RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'ASSETS', 'TIMELINE', 'RENDER', 'QA', 'PUBLISH'];

class AsyncEpisodeOrchestrator {
  constructor({ pool, leaseSeconds = 300 }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }

  async enqueue({ episodeId, projectId = null, brief, stages = ORDER, actor = 'workflow', idempotencyPrefix = randomUUID() }) {
    if (!episodeId) throw new TypeError('episodeId is required');
    if (!String(brief || '').trim()) throw new TypeError('brief is required');
    if (!Array.isArray(stages) || stages.length === 0) throw new TypeError('stages must be a non-empty array');
    const requested = new Set(stages);
    if (requested.size !== stages.length) throw new TypeError('stages must not contain duplicates');
    for (const stage of stages) {
      if (!ORDER.includes(stage)) throw new TypeError('Unknown workflow stage: ' + stage);
      for (const dependency of WORKFLOW_DEPENDENCIES[stage] || []) {
        if (!requested.has(dependency)) throw new Error('Stage ' + stage + ' requires ' + dependency);
      }
    }
    // Jobs in this pipeline are intentionally serial. Reject out-of-order custom
    // sequences rather than creating a dependency chain that violates semantics.
    const sorted = [...stages].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    if (sorted.some((stage, index) => stage !== stages[index])) throw new TypeError('stages must be in canonical dependency order');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobs = [];
      let dependsOnJobId = null;
      for (const stage of stages) {
        const id = randomUUID();
        const idempotencyKey = idempotencyPrefix + ':' + episodeId + ':' + stage;
        const result = await client.query(
          `INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,priority,max_attempts,idempotency_key,created_by,depends_on_job_id)
           VALUES($1,$2,$3,$4,$5::jsonb,100,3,$6,$7,$8)
           ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=forge_jobs.updated_at
           RETURNING *`,
          [id, projectId, episodeId, 'workflow:' + stage.toLowerCase(), JSON.stringify({ episodeId, projectId, brief, stage, actor }), idempotencyKey, actor, dependsOnJobId],
        );
        const job = result.rows[0];
        jobs.push(job);
        dependsOnJobId = job.id;
      }
      await client.query('COMMIT');
      return { episodeId, jobs };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { AsyncEpisodeOrchestrator, WORKFLOW_STAGE_ORDER: ORDER };
