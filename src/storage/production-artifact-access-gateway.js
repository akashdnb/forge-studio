const { ArtifactAccessGateway, ArtifactAccessError, verifyToken, signToken } = require('./artifact-access-gateway');
const { randomUUID } = require('node:crypto');
const RELEASED_EPISODE_STATES = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED']);
class ProductionArtifactAccessGateway extends ArtifactAccessGateway {
  async _projectRole(projectId, actor, tenantId = null) {
    const result = await this.repository.db.pool.query(`SELECT p.tenant_id,p.created_by,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1`, [projectId, actor]);
    const row = result.rows[0]; if (!row || (tenantId && row.tenant_id !== tenantId)) return null;
    return row.role || (row.created_by === actor ? 'OWNER' : null);
  }
  async _authorize(artifactId, options = {}) {
    try {
      const artifact = await this._loadArtifact(artifactId);
      if (!artifact) throw new ArtifactAccessError('Artifact not found', 'ARTIFACT_NOT_FOUND', 404);
      const role = await this._projectRole(artifact.project_id, options.actor, options.tenantId || null);
      if (!role && !this.adminActors.has(options.actor) && !this.workerActors.has(options.actor)) throw new ArtifactAccessError('Artifact access denied', 'FORBIDDEN', 403);
      const access = await super._authorize(artifactId, options);
      const recovery = Boolean(options.recovery);
      const released = RELEASED_EPISODE_STATES.has(access.artifact.episode_state) && access.artifact.approved_render_id === access.artifact.id;
      if (options.action === 'metadata' && !recovery && !access.worker && !released) throw new ArtifactAccessError('Artifact is not approved for delivery', 'APPROVAL_REQUIRED', 403);
      return access;
    } catch (error) {
      try { const artifact = await this._loadArtifact(artifactId); if (artifact && options.actor) await this._audit(artifact, options.actor, 'ARTIFACT_ACCESS_DENIED', { action: options.action || 'metadata', code: error.code || 'ACCESS_DENIED' }); } catch {}
      throw error;
    }
  }
  async resolve({ artifactId, actor, tenantId = null, action = 'metadata', token = null, purpose = 'user', recovery = false }) {
    if (token) {
      const payload = verifyToken(token, this.signingSecret, this.clock());
      if (payload.artifactId !== artifactId || payload.actor !== actor || payload.tenantId !== tenantId) throw new ArtifactAccessError('Access token does not match requested artifact', 'TOKEN_BINDING_MISMATCH', 403);
      if (payload.action !== action && !(payload.action === 'download' && action === 'stream')) throw new ArtifactAccessError('Access token does not permit requested delivery mode', 'TOKEN_BINDING_MISMATCH', 403);
      purpose = payload.purpose || purpose; recovery = Boolean(payload.recovery);
      return this._authorize(artifactId, { actor, tenantId, action: payload.action === 'download' ? 'download' : action, purpose, recovery });
    }
    return this._authorize(artifactId, { actor, tenantId, action, purpose, recovery });
  }
  async issueToken({ artifactId, actor, tenantId = null, action = 'download', purpose = 'user', recovery = false }) {
    const access = await this._authorize(artifactId, { actor, tenantId, action, purpose, recovery });
    const now = Math.floor(this.clock() / 1000);
    const token = signToken({ v: 1, jti: randomUUID(), artifactId: access.artifact.id, actor, tenantId, action, purpose, recovery: Boolean(recovery), iat: now, nbf: now, exp: now + this.tokenTtlSeconds }, this.signingSecret);
    await this._audit(access.artifact, actor, 'ARTIFACT_ACCESS_TOKEN_ISSUED', { action, purpose, recovery: Boolean(recovery) });
    return { token, expiresAt: new Date((now + this.tokenTtlSeconds) * 1000).toISOString(), artifactId: access.artifact.id };
  }
  async metadata({ artifactId, actor, tenantId = null, token = null, recovery = false }) {
    const { artifact } = await this.resolve({ artifactId, actor, tenantId, action: 'metadata', token, recovery });
    await this._audit(artifact, actor, 'ARTIFACT_METADATA_READ', {});
    return { id: artifact.id, episodeId: artifact.episode_id, projectId: artifact.project_id, versionId: artifact.version_id, kind: artifact.kind, mediaType: artifact.media_type || 'application/octet-stream', contentHash: artifact.content_hash, contentLength: Number(artifact.size_bytes), lifecycleState: artifact.lifecycle_state || 'RETAINED' };
  }
  async open({ artifactId, actor, tenantId = null, rangeHeader = null, token = null, purpose = 'user', recovery = false }) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact || !(await this._projectRole(artifact.project_id, actor, tenantId))) throw new ArtifactAccessError('Artifact access denied', 'FORBIDDEN', 403);
    return super.open({ artifactId, actor, rangeHeader, token, purpose, recovery });
  }
  async _audit(artifact, actor, action, details) { await this.repository.db.pool.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,'artifact',$5,$6::jsonb)`, [artifact.project_id, artifact.episode_id, actor, action, artifact.id, JSON.stringify({ ...details, artifactVersionId: artifact.version_id })]); }
}
module.exports = { ProductionArtifactAccessGateway };
