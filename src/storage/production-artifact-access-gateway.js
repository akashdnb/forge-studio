const { ArtifactAccessGateway } = require('./artifact-access-gateway');

class ProductionArtifactAccessGateway extends ArtifactAccessGateway {
  async _reachable(artifact) {
    const result = await this.repository.db.pool.query(`WITH RECURSIVE seeds AS (
        SELECT value AS version_id FROM episodes e, jsonb_each_text(e.current_versions) WHERE e.id=$1
        UNION
        SELECT version_id FROM artifacts WHERE id IN (SELECT current_render_id FROM episodes WHERE id=$1 UNION SELECT approved_render_id FROM episodes WHERE id=$1)
      ), reachable AS (
        SELECT version_id FROM seeds
        UNION
        SELECT d.depends_on_version_id FROM version_dependencies d JOIN reachable r ON r.version_id=d.version_id WHERE d.episode_id=$1
      ) SELECT 1 FROM reachable WHERE version_id=$2 LIMIT 1`, [artifact.episode_id, artifact.version_id]);
    return Boolean(result.rows[0]);
  }
}

module.exports = { ProductionArtifactAccessGateway };
