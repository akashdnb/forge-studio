const { PostgresRepository } = require('./postgres-repository');
const { immutableRecord, requiredString } = require('../domain/records');
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

  async createProject(input) {
    const id = requiredString(input.id, 'id');
    const name = requiredString(input.name, 'name');
    try {
      return await this.db.createProject({ ...input, id, name });
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
    const artifact = await this.db.registerArtifact(input);
    return artifact;
  }

  async createProviderRun(input) {
    try { return await this.db.createProviderRun(input); }
    catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Provider run ID already exists'), { code: 'CONFLICT' });
      if (error.code === '23503') throw Object.assign(new Error('Episode does not exist'), { code: 'NOT_FOUND' });
      throw error;
    }
  }

  async recordCost(input) { return this.db.recordCost(input); }
  async episodeCost(episodeId) { return this.db.episodeCost(episodeId); }

  async recordQa(input) { return this.db.recordQa(input); }
  async appendApproval(input) { return this.db.appendApproval(input); }
  async invalidationPlan(versionId) { return this.db.invalidationPlan(versionId); }
}

module.exports = { PersistentProductionRepository, fromDb };
