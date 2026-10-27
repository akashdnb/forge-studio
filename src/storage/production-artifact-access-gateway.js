const { ArtifactAccessGateway, ArtifactAccessError, parseRange } = require('./artifact-access-gateway');
const { ArtifactDeliveryCache } = require('./artifact-delivery-cache');
const { verifyCachedFile } = require('./artifact-cache-integrity');
const { getActiveObservability } = require('../observability');
const { ArtifactDeliveryGrantService } = require('./artifact-delivery-grants');
const RELEASED_EPISODE_STATES = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED']);

class ProductionArtifactAccessGateway extends ArtifactAccessGateway {
  constructor(options = {}) {
    super(options);
    this.deliveryCache = options.deliveryCache || new ArtifactDeliveryCache({ observability: options.observability || null });
    this.grantService = options.grantService || (this.repository?.db?.pool ? new ArtifactDeliveryGrantService({
      pool: this.repository.db.pool,
      kms: options.kms || null,
      legacySecret: this.signingSecret,
      clock: this.clock,
      tokenTtlSeconds: this.tokenTtlSeconds,
      maxRangeBytes: this.maxRangeBytes,
      maxTransferBytes: this.maxTransferBytes,
      observability: options.observability || null,
    }) : null);
  }

  async _projectRole(projectId, actor, tenantId = null) {
    const result = await this.repository.db.pool.query(`SELECT p.tenant_id,p.created_by,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1`, [projectId, actor]);
    const row = result.rows[0];
    if (!row || (tenantId && row.tenant_id !== tenantId)) return null;
    return row.role || (row.created_by === actor ? 'OWNER' : null);
  }

  async _authorize(artifactId, options = {}) {
    try {
      const artifact = await this._loadArtifact(artifactId);
      if (!artifact) throw new ArtifactAccessError('Artifact not found', 'ARTIFACT_NOT_FOUND', 404);
      const role = await this._projectRole(artifact.project_id, options.actor, options.tenantId || null);
      if (!role && !this.adminActors.has(options.actor) && !this.workerActors.has(options.actor)) throw new ArtifactAccessError('Artifact access denied', 'FORBIDDEN', 403);
      const recovery = Boolean(options.recovery);
      const quarantine = await this.repository.db.pool.query(`SELECT 1 FROM forge_compensation_artifact_quarantines q WHERE q.artifact_id=$1 AND q.status='QUARANTINED' AND q.tenant_id=(SELECT tenant_id FROM projects WHERE id=$2) LIMIT 1`, [artifactId, artifact.project_id]);
      if (quarantine.rows[0] && !recovery) throw new ArtifactAccessError('Artifact is quarantined by workflow compensation', 'ARTIFACT_QUARANTINED', 409);
      const access = await super._authorize(artifactId, options);
      const released = RELEASED_EPISODE_STATES.has(access.artifact.episode_state) && access.artifact.approved_render_id === access.artifact.id;
      if (options.action === 'metadata' && !recovery && !access.worker && !released) throw new ArtifactAccessError('Artifact is not approved for delivery', 'APPROVAL_REQUIRED', 403);
      return access;
    } catch (error) {
      try {
        const artifact = await this._loadArtifact(artifactId);
        if (artifact && options.actor) await this._audit(artifact, options.actor, 'ARTIFACT_ACCESS_DENIED', { action: options.action || 'metadata', code: error.code || 'ACCESS_DENIED' });
      } catch {}
      throw error;
    }
  }

  async resolve({ artifactId, actor, tenantId = null, action = 'metadata', token = null, purpose = 'user', recovery = false, audience = null, rangeHeader = null, requestId = null }) {
    if (token) {
      if (!this.grantService) throw new ArtifactAccessError('Artifact delivery grants are unavailable', 'DELIVERY_AUTH_UNAVAILABLE', 503);
      const payload = await this.grantService.authorize({ token, artifactId, actor, tenantId, action, audience: audience || undefined, rangeHeader, requestId });
      purpose = payload.purpose || purpose;
      recovery = Boolean(payload.recovery);
      action = payload.action === 'download' ? (action === 'stream' ? 'stream' : 'download') : action;
    }
    return this._authorize(artifactId, { actor, tenantId, action, purpose, recovery });
  }

  async issueToken({ artifactId, actor, tenantId = null, action = 'download', purpose = 'user', recovery = false, audience = 'browser', maxUses = 1, maxBytes = null, rangeStart = null, rangeEnd = null, ttlSeconds = null, projectId = null, requestId = null }) {
    const access = await this._authorize(artifactId, { actor, tenantId, action, purpose, recovery });
    if (!this.grantService) throw new ArtifactAccessError('Artifact delivery grants are unavailable', 'DELIVERY_AUTH_UNAVAILABLE', 503);
    return this.grantService.issue({ artifactId: access.artifact.id, actor, tenantId, projectId: projectId || access.artifact.project_id, action, purpose, audience, maxUses, maxBytes, rangeStart, rangeEnd, ttlSeconds: ttlSeconds || undefined, requestId });
  }

  async metadata({ artifactId, actor, tenantId = null, token = null, recovery = false, requestId = null }) {
    const { artifact } = await this.resolve({ artifactId, actor, tenantId, action: 'metadata', token, recovery, requestId });
    await this._audit(artifact, actor, 'ARTIFACT_METADATA_READ', {});
    return { id: artifact.id, episodeId: artifact.episode_id, projectId: artifact.project_id, versionId: artifact.version_id, kind: artifact.kind, mediaType: artifact.media_type || 'application/octet-stream', contentHash: artifact.content_hash, contentLength: Number(artifact.size_bytes), lifecycleState: artifact.lifecycle_state || 'RETAINED' };
  }

  async open({ artifactId, actor, tenantId = null, rangeHeader = null, token = null, purpose = 'user', recovery = false, audience = null, signal, requestId = null }) {
    const access = await this.resolve({ artifactId, actor, tenantId, action: rangeHeader ? 'stream' : 'download', token, purpose, recovery, audience, rangeHeader, requestId });
    const artifact = access.artifact;
    const sizeBytes = Number(artifact.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > this.maxTransferBytes) throw new ArtifactAccessError('Artifact exceeds configured transfer limit', 'TRANSFER_TOO_LARGE', 413);
    const range = parseRange(rangeHeader, sizeBytes, this.maxRangeBytes);
    if (!this.deliveryCache) return super.open({ artifactId, actor, rangeHeader, token, purpose, recovery });
    this.deliveryCache.observability = this.deliveryCache.observability || getActiveObservability();
    try {
      const resolved = await this.deliveryCache.open({ tenantId: tenantId || artifact.project_id, artifact, originStorage: this.storage, range, signal });
      await verifyCachedFile({ path: resolved.key, expectedSha256: artifact.content_hash, expectedSize: artifact.size_bytes });
      const actualLength = range ? range.length : resolved.sizeBytes;
      if (actualLength !== (range ? range.length : sizeBytes)) throw new ArtifactAccessError('Cached content length mismatch', 'CONTENT_LENGTH_MISMATCH', 503);
      await this._audit(artifact, actor, range ? 'ARTIFACT_STREAM_CACHE' : 'ARTIFACT_DOWNLOAD_CACHE', { bytes: actualLength, ranged: Boolean(range), cache: true, purpose, requestId });
      const safeKind = String(artifact.kind || 'artifact').replace(/[^A-Za-z0-9._-]/g, 'artifact');
      const ext = String(artifact.media_type || '').split('/')[1]?.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'bin';
      return { artifact, stream: resolved.stream, statusCode: range ? 206 : 200, contentLength: actualLength, contentRange: range ? `bytes ${range.start}-${range.end}/${sizeBytes}` : null, contentType: artifact.media_type || 'application/octet-stream', contentDisposition: `attachment; filename=\"forge-${safeKind}-${artifact.id}.${ext}\"`, etag: `\"sha256-${artifact.content_hash}\"`, acceptRanges: 'bytes' };
    } catch (error) {
      if (error.code === 'CHECKSUM_MISMATCH' || error.code === 'CONTENT_LENGTH_MISMATCH') await this.deliveryCache.evict({ tenantId: tenantId || artifact.project_id, sha256: artifact.content_hash, reason: 'integrity_failure' }).catch(() => {});
      if (error.code === 'ARTIFACT_NOT_FOUND' || error.code === 'ARTIFACT_CORRUPT' || error.code === 'CHECKSUM_MISMATCH') throw new ArtifactAccessError('Artifact delivery failed', error.code === 'CHECKSUM_MISMATCH' ? 'ARTIFACT_CORRUPT' : error.code, error.code === 'ARTIFACT_NOT_FOUND' ? 404 : 503);
      throw error;
    }
  }

  async _audit(artifact, actor, action, details) {
    await this.repository.db.pool.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,'artifact',$5,$6::jsonb)`, [artifact.project_id, artifact.episode_id, actor, action, artifact.id, JSON.stringify({ ...details, artifactVersionId: artifact.version_id })]);
  }
}
module.exports = { ProductionArtifactAccessGateway };
