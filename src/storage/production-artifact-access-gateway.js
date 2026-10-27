const { ArtifactAccessGateway, ArtifactAccessError, verifyToken } = require('./artifact-access-gateway');

const RELEASED_EPISODE_STATES = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED']);

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

  async _authorize(artifactId, options = {}) {
    try {
      const access = await super._authorize(artifactId, options);
      const recovery = Boolean(options.recovery);
      const released = RELEASED_EPISODE_STATES.has(access.artifact.episode_state) && access.artifact.approved_render_id === access.artifact.id;
      if (options.action === 'metadata' && !recovery && !access.worker && !released) throw new ArtifactAccessError('Artifact is not approved for delivery', 'APPROVAL_REQUIRED', 403);
      return access;
    } catch (error) {
      try {
        const artifact = await this._loadArtifact(artifactId);
        if (artifact && options.actor) await this._audit(artifact, options.actor, 'ARTIFACT_ACCESS_DENIED', { action: options.action || 'metadata', code: error.code || 'ACCESS_DENIED' });
      } catch { /* denial remains fail-closed if audit persistence is unavailable */ }
      throw error;
    }
  }

  async resolve({ artifactId, actor, action = 'metadata', token = null, purpose = 'user', recovery = false }) {
    if (token) {
      const payload = verifyToken(token, this.signingSecret, this.clock());
      if (payload.artifactId !== artifactId || payload.actor !== actor) throw new ArtifactAccessError('Access token does not match requested artifact', 'TOKEN_BINDING_MISMATCH', 403);
      if (payload.action !== action && !(payload.action === 'download' && action === 'stream')) throw new ArtifactAccessError('Access token does not permit requested delivery mode', 'TOKEN_BINDING_MISMATCH', 403);
      purpose = payload.purpose || purpose; recovery = Boolean(payload.recovery);
      return this._authorize(artifactId, { actor, action: payload.action === 'download' ? 'download' : action, purpose, recovery });
    }
    return this._authorize(artifactId, { actor, action, purpose, recovery });
  }

  async _audit(artifact, actor, action, details) {
    await this.repository.db.pool.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,'artifact',$5,$6::jsonb)`, [artifact.project_id, artifact.episode_id, actor, action, artifact.id, JSON.stringify({ ...details, artifactVersionId: artifact.version_id })]);
  }
}

module.exports = { ProductionArtifactAccessGateway };
