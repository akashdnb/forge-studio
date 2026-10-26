const { PostgresRepository } = require('./postgres-repository');
const { requiredString } = require('../domain/records');
const { EPISODE_STATES, TRANSITIONS } = require('../domain/episode-service');

function fromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description,
    state: row.state,
    revision: Number(row.revision),
    currentVersions: row.current_versions || {},
    currentRenderId: row.current_render_id,
    approvedRenderId: row.approved_render_id,
    publishedRecordId: row.published_record_id,
    createdBy: row.created_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class PersistentProductionRepository {
  constructor({ pool }) {
    this.db = new PostgresRepository({ pool });
  }

  async migrate(options) { return this.db.migrate(options); }

  async createProject({ id, name, createdBy = 'system', metadata = {} }) {
    id = requiredString(id, 'id');
    name = requiredString(name, 'name');
    try {
      return await this.db.createProject({ id, name, createdBy, metadata });
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Project already exists'), { code: 'CONFLICT' });
      throw error;
    }
  }

  async createEpisode(input) {
    const normalized = {
      ...input,
      id: requiredString(input.id, 'id'),
      projectId: requiredString(input.projectId, 'projectId'),
      title: requiredString(input.title, 'title'),
    };
    try {
      const row = await this.db.withTransaction(async (client) => {
        const created = await this.db.createEpisode(normalized, client);
        await client.query(
          "INSERT INTO audit_events (project_id, episode_id, actor, action, target_type, target_id, details) VALUES ($1,$2,$3,'EPISODE_CREATED','episode',$2,$4::jsonb)",
          [created.project_id, created.id, normalized.createdBy || 'system', JSON.stringify({ title: created.title })],
        );
        return created;
      });
      return fromDb(row);
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Episode already exists'), { code: 'CONFLICT' });
      if (error.code === '23503') throw Object.assign(new Error('Project does not exist'), { code: 'NOT_FOUND' });
      throw error;
    }
  }

  async getEpisode(id) { return fromDb(await this.db.getEpisode(id)); }

  async listEpisodes({ projectId, limit, offset } = {}) {
    const rows = await this.db.listEpisodes({ projectId, limit, offset });
    return rows.map(fromDb);
  }

  async transitionEpisode({ id, nextState, actor = 'system', reason = null, expectedRevision }) {
    if (!EPISODE_STATES.includes(nextState)) throw new TypeError(`Unknown episode state: ${nextState}`);
    return this.db.withTransaction(async (client) => {
      const result = await client.query('SELECT * FROM episodes WHERE id = $1 FOR UPDATE', [id]);
      const current = result.rows[0];
      if (!current) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      if (expectedRevision !== undefined && Number(current.revision) !== expectedRevision) {
        throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      }
      if (!TRANSITIONS[current.state].includes(nextState)) {
        throw Object.assign(new Error(`Illegal episode transition: ${current.state} -> ${nextState}`), { code: 'STATE_CONFLICT' });
      }
      const updated = await client.query(
        'UPDATE episodes SET state = $1, revision = revision + 1, updated_at = now() WHERE id = $2 AND revision = $3 RETURNING *',
        [nextState, id, current.revision],
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      await client.query(
        "INSERT INTO audit_events (project_id, episode_id, actor, action, target_type, target_id, details) VALUES ($1,$2,$3,'EPISODE_STATE_TRANSITION','episode',$2,$4::jsonb)",
        [current.project_id, id, actor, JSON.stringify({ from: current.state, to: nextState, reason })],
      );
      return fromDb(updated.rows[0]);
    });
  }

  async selectRender({ id, renderArtifactId, expectedRevision }) {
    return this.db.withTransaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM episodes WHERE id = $1 FOR UPDATE', [id]);
      const current = currentResult.rows[0];
      if (!current) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      if (expectedRevision !== undefined && Number(current.revision) !== expectedRevision) {
        throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      }
      const artifact = await client.query('SELECT id FROM artifacts WHERE id = $1 AND episode_id = $2 AND kind = $3', [renderArtifactId, id, 'render']);
      if (!artifact.rows[0]) throw Object.assign(new Error('Render artifact not found for episode'), { code: 'NOT_FOUND' });
      const result = await client.query(
        'UPDATE episodes SET current_render_id = $1, approved_render_id = NULL, revision = revision + 1, updated_at = now() WHERE id = $2 AND revision = $3 RETURNING *',
        [renderArtifactId, id, current.revision],
      );
      return fromDb(result.rows[0]);
    });
  }

  async registerArtifact(input) {
    const result = await this.db.withTransaction(async (client) => {
      const episode = await client.query('SELECT project_id FROM episodes WHERE id = $1 FOR SHARE', [input.episodeId]);
      if (!episode.rows[0]) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      const version = await client.query(
        'SELECT id FROM version_records WHERE id = $1 AND episode_id = $2',
        [input.versionId, input.episodeId],
      );
      if (!version.rows[0]) throw Object.assign(new Error('Artifact version not found for episode'), { code: 'INVALID_PROVENANCE' });
      return this.db.registerArtifact({ ...input, createdBy: input.createdBy || 'system' });
    });
    return result;
  }

  async createProviderRun(input) {
    try {
      const episode = await this.db.getEpisode(input.episodeId);
      if (!episode) throw Object.assign(new Error('Episode does not exist'), { code: 'NOT_FOUND' });
      const result = await this.db.createProviderRun(input);
      return result;
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Provider run ID already exists'), { code: 'CONFLICT' });
      if (error.code === '23503') throw Object.assign(new Error('Episode does not exist'), { code: 'NOT_FOUND' });
      throw error;
    }
  }

  async recordCost(input) { return this.db.recordCost(input); }
  async episodeCost(episodeId) { return this.db.episodeCost(episodeId); }

  async recordQa(input) {
    const artifact = await this.db.pool.query(
      'SELECT id FROM artifacts WHERE id = $1 AND episode_id = $2 AND version_id = $3',
      [input.artifactId, input.episodeId, input.versionId],
    );
    if (!artifact.rows[0]) throw Object.assign(new Error('QA artifact/version provenance mismatch'), { code: 'INVALID_PROVENANCE' });
    return this.db.recordQa(input);
  }

  async appendApproval(input) {
    return this.db.withTransaction(async (client) => {
      const episodeResult = await client.query('SELECT * FROM episodes WHERE id = $1 FOR UPDATE', [input.episodeId]);
      const episode = episodeResult.rows[0];
      if (!episode) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      if (input.stage === 'FINAL_RENDER' && input.decision === 'APPROVED') {
        const artifact = await client.query(
          `SELECT a.id, a.version_id FROM artifacts a
           JOIN qa_results q ON q.artifact_id = a.id AND q.version_id = a.version_id
           WHERE a.id = $1 AND a.episode_id = $2 AND a.version_id = $3 AND a.kind = 'render'
             AND q.status IN ('PASSED','WARNINGS')
           ORDER BY q.created_at DESC LIMIT 1`,
          [input.targetId, input.episodeId, input.targetVersionId],
        );
        if (!artifact.rows[0]) throw Object.assign(new Error('Final render has no passing QA'), { code: 'QA_BLOCKED' });
        if (episode.current_render_id !== input.targetId) throw Object.assign(new Error('Only the current selected render can be approved'), { code: 'STATE_CONFLICT' });
        if (episode.state !== 'AWAITING_APPROVAL') throw Object.assign(new Error('Episode is not awaiting approval'), { code: 'STATE_CONFLICT' });
        const approved = await client.query(
          "UPDATE episodes SET state = 'APPROVED', approved_render_id = $1, revision = revision + 1, updated_at = now() WHERE id = $2 RETURNING *",
          [input.targetId, input.episodeId],
        );
        await client.query(
          'INSERT INTO approvals (id,episode_id,stage,target_id,target_version_id,decision,actor,comments,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
          [input.id, input.episodeId, input.stage, input.targetId, input.targetVersionId, input.decision, input.actor, input.comments || '', JSON.stringify(input.evidence || {})],
        );
        await client.query(
          "INSERT INTO audit_events (project_id,episode_id,actor,action,target_type,target_id,details) VALUES ($1,$2,$3,'FINAL_RENDER_APPROVED','artifact',$4,$5::jsonb)",
          [episode.project_id, input.episodeId, input.actor, input.targetId, JSON.stringify({ versionId: input.targetVersionId })],
        );
        return { episode: fromDb(approved.rows[0]), approval: { ...input } };
      }
      return this.db.appendApproval(input);
    });
  }

  async invalidationPlan(versionId) { return this.db.invalidationPlan(versionId); }
}

module.exports = { PersistentProductionRepository, fromDb };
