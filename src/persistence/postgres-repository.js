const { readFile } = require('node:fs/promises');
const path = require('node:path');

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new TypeError(`${label} must be a safe SQL identifier`);
  }
  return value;
}

class PostgresRepository {
  constructor({ pool, schema = 'public' }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('A pg-compatible pool is required');
    }
    this.pool = pool;
    this.schema = safeIdentifier(schema, 'schema');
  }

  async migrate({ migrationPath = path.join(__dirname, '..', '..', 'migrations', '001_initial_schema.sql') } = {}) {
    const sql = await readFile(migrationPath, 'utf8');
    await this.pool.query(sql);
    return { applied: ['001_initial_schema.sql'] };
  }

  async withTransaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async createProject({ id, name, createdBy = 'system', metadata = {} }) {
    const result = await this.pool.query(
      'INSERT INTO projects (id, name, created_by, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
      [id, name, createdBy, JSON.stringify(metadata)],
    );
    return result.rows[0];
  }

  async createEpisode({ id, projectId, channelId = null, title, description = '', createdBy = 'system', metadata = {} }, client = this.pool) {
    const result = await client.query(
      `INSERT INTO episodes (id, project_id, channel_id, title, description, created_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [id, projectId, channelId, title, description, createdBy, JSON.stringify(metadata)],
    );
    return result.rows[0];
  }

  async getEpisode(id, client = this.pool) {
    const result = await client.query('SELECT * FROM episodes WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async listEpisodes({ projectId, limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be non-negative');
    const result = projectId
      ? await this.pool.query('SELECT * FROM episodes WHERE project_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [projectId, limit, offset])
      : await this.pool.query('SELECT * FROM episodes ORDER BY updated_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return result.rows;
  }

  async transitionEpisode({ id, nextState, actor = 'system', reason = null, expectedRevision }) {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM episodes WHERE id = $1 FOR UPDATE', [id]);
      const current = currentResult.rows[0];
      if (!current) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      if (expectedRevision !== undefined && Number(current.revision) !== expectedRevision) {
        throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      }
      // State transitions must be validated by the domain service before calling this
      // method; the allowed state constraint in SQL provides a second validation layer.
      const result = await client.query(
        `UPDATE episodes SET state = $1, revision = revision + 1, updated_at = now()
         WHERE id = $2 AND revision = $3 RETURNING *`,
        [nextState, id, current.revision],
      );
      if (!result.rows[0]) throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      await client.query(
        `INSERT INTO audit_events (project_id, episode_id, actor, action, target_type, target_id, details)
         VALUES ($1, $2, $3, 'EPISODE_STATE_TRANSITION', 'episode', $2, $4::jsonb)`,
        [current.project_id, id, actor, JSON.stringify({ from: current.state, to: nextState, reason })],
      );
      return result.rows[0];
    });
  }

  async appendVersion({ id, episodeId, kind, parentId = null, payload = {}, contentHash = null, dependencies = [], createdBy = 'system' }) {
    return this.withTransaction(async (client) => {
      const episode = await client.query('SELECT id FROM episodes WHERE id = $1 FOR UPDATE', [episodeId]);
      if (!episode.rows[0]) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      const inserted = await client.query(
        `INSERT INTO version_records (id, episode_id, kind, parent_id, payload, content_hash, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
        [id, episodeId, kind, parentId, JSON.stringify(payload), contentHash, createdBy],
      );
      const ids = [...new Set(dependencies)];
      for (const dependencyId of ids) {
        const dependency = await client.query(
          'SELECT episode_id FROM version_records WHERE id = $1 FOR SHARE', [dependencyId],
        );
        if (!dependency.rows[0] || dependency.rows[0].episode_id !== episodeId) {
          throw Object.assign(new Error('Unknown or cross-episode version dependency'), { code: 'INVALID_DEPENDENCY' });
        }
        await client.query(
          'INSERT INTO version_dependencies (episode_id, version_id, depends_on_version_id) VALUES ($1, $2, $3)',
          [episodeId, id, dependencyId],
        );
      }
      return inserted.rows[0];
    });
  }

  async invalidationPlan(versionId) {
    const result = await this.pool.query(
      `WITH RECURSIVE descendants(version_id, depth) AS (
         SELECT version_id, 1 FROM version_dependencies WHERE depends_on_version_id = $1
         UNION
         SELECT vd.version_id, d.depth + 1
         FROM version_dependencies vd JOIN descendants d ON vd.depends_on_version_id = d.version_id
       )
       SELECT DISTINCT vr.*, d.depth
       FROM descendants d JOIN version_records vr ON vr.id = d.version_id
       ORDER BY d.depth, vr.created_at`,
      [versionId],
    );
    return result.rows;
  }

  async registerArtifact({
    id, episodeId, kind, versionId, storageUri = null, content = null, contentHash = null,
    mediaType = null, providerRunId = null, source = 'forge', license = null,
    inputVersionIds = [], metadata = {}, createdBy = 'system',
  }) {
    if (!storageUri && content === null) throw new TypeError('storageUri or content is required');
    const result = await this.pool.query(
      `INSERT INTO artifacts
       (id, episode_id, kind, version_id, storage_uri, content_json, content_hash, media_type,
        provider_run_id, source, license, input_version_ids, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
       RETURNING *`,
      [id, episodeId, kind, versionId, storageUri, content === null ? null : JSON.stringify(content),
        contentHash, mediaType, providerRunId, source, JSON.stringify(license), JSON.stringify(inputVersionIds),
        JSON.stringify(metadata), createdBy],
    );
    return result.rows[0];
  }

  async createProviderRun(input) {
    const result = await this.pool.query(
      `INSERT INTO provider_runs
       (id, episode_id, capability, provider, model, input_version_ids, idempotency_key, request, attempt)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [input.id, input.episodeId, input.capability, input.provider, input.model || null,
        JSON.stringify(input.inputVersionIds || []), input.idempotencyKey, JSON.stringify(input.request || {}),
        input.attempt || 1],
    );
    return result.rows[0];
  }

  async recordCost(input) {
    return this.withTransaction(async (client) => {
      const run = await client.query('SELECT episode_id FROM provider_runs WHERE id = $1 FOR SHARE', [input.runId]);
      if (!run.rows[0] || run.rows[0].episode_id !== input.episodeId) {
        throw Object.assign(new Error('Cost record episode must match provider run'), { code: 'INVALID_COST_OWNERSHIP' });
      }
      const result = await client.query(
        `INSERT INTO cost_records (id, provider_run_id, episode_id, provider, model, operation, input_units, output_units,
         estimated_cost, actual_cost, currency, is_retry, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
        [input.id, input.runId, input.episodeId, input.provider, input.model || null, input.operation,
          input.inputUnits || 0, input.outputUnits || 0, input.estimatedCost ?? null, input.actualCost ?? null,
          input.currency || 'USD', Boolean(input.isRetry), JSON.stringify(input.metadata || {})],
      );
      return result.rows[0];
    });
  }

  async episodeCost(episodeId) {
    const result = await this.pool.query(
      `SELECT currency,
         COALESCE(SUM(estimated_cost), 0)::text AS estimated,
         COALESCE(SUM(actual_cost), 0)::text AS actual,
         COUNT(estimated_cost)::int AS estimated_records,
         COUNT(actual_cost)::int AS actual_records,
         COUNT(*)::int AS record_count
       FROM cost_records WHERE episode_id = $1 GROUP BY currency ORDER BY currency`,
      [episodeId],
    );
    return result.rows;
  }

  async appendApproval(input) {
    const result = await this.pool.query(
      `INSERT INTO approvals (id, episode_id, stage, target_id, target_version_id, decision, actor, comments, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [input.id, input.episodeId, input.stage, input.targetId, input.targetVersionId,
        input.decision, input.actor, input.comments || '', JSON.stringify(input.evidence || {})],
    );
    return result.rows[0];
  }

  async recordQa(input) {
    const result = await this.pool.query(
      `INSERT INTO qa_results (id, episode_id, artifact_id, version_id, status, checks, runner, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING *`,
      [input.id, input.episodeId, input.artifactId, input.versionId, input.status,
        JSON.stringify(input.checks || []), input.runner || 'forge-core', JSON.stringify(input.metadata || {})],
    );
    return result.rows[0];
  }
}

module.exports = { PostgresRepository, safeIdentifier };
