const crypto = require('node:crypto');

const DEFAULT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_MAX_RANGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_KIND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DENIED_LIFECYCLE = new Set(['QUARANTINED', 'DELETED', 'SUPERSEDED']);
const RELEASED_EPISODE_STATES = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED']);

class ArtifactAccessError extends Error {
  constructor(message, code, statusCode = 403) {
    super(message);
    this.name = 'ArtifactAccessError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeArtifactId(value) {
  if (typeof value !== 'string' || !SAFE_ARTIFACT_ID.test(value)) throw new ArtifactAccessError('Invalid artifact identifier', 'INVALID_ARTIFACT_ID', 400);
  return value;
}

function parseRange(header, sizeBytes, maxRangeBytes = DEFAULT_MAX_RANGE_BYTES) {
  if (!header) return null;
  if (typeof header !== 'string' || !/^bytes=\d*-\d*$/.test(header)) throw new ArtifactAccessError('Malformed byte range', 'INVALID_RANGE', 416);
  if (header.includes(',')) throw new ArtifactAccessError('Multiple byte ranges are not supported', 'MULTI_RANGE_UNSUPPORTED', 416);
  const [startText, endText] = header.slice(6).split('-');
  let start; let end;
  if (!startText && !endText) throw new ArtifactAccessError('Malformed byte range', 'INVALID_RANGE', 416);
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ArtifactAccessError('Invalid suffix range', 'INVALID_RANGE', 416);
    start = Math.max(0, sizeBytes - suffix);
    end = sizeBytes - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : sizeBytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new ArtifactAccessError('Invalid byte range', 'INVALID_RANGE', 416);
    if (start >= sizeBytes) throw new ArtifactAccessError('Requested range is not satisfiable', 'RANGE_NOT_SATISFIABLE', 416);
    end = Math.min(end, sizeBytes - 1);
  }
  const length = end - start + 1;
  if (length > maxRangeBytes) throw new ArtifactAccessError(`Requested range exceeds ${maxRangeBytes} byte limit`, 'RANGE_TOO_LARGE', 416);
  return { start, end, length };
}

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret) throw new ArtifactAccessError('Invalid access token', 'INVALID_ACCESS_TOKEN', 401);
  const parts = token.split('.');
  if (parts.length !== 2) throw new ArtifactAccessError('Invalid access token', 'INVALID_ACCESS_TOKEN', 401);
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const a = Buffer.from(expected); const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ArtifactAccessError('Invalid access token', 'INVALID_ACCESS_TOKEN', 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw new ArtifactAccessError('Invalid access token', 'INVALID_ACCESS_TOKEN', 401); }
  if (!payload || payload.v !== 1 || !payload.jti || !payload.artifactId || !payload.actor || !Number.isInteger(payload.exp)) throw new ArtifactAccessError('Invalid access token', 'INVALID_ACCESS_TOKEN', 401);
  if (payload.exp * 1000 <= now) throw new ArtifactAccessError('Artifact access token has expired', 'ACCESS_TOKEN_EXPIRED', 401);
  if (payload.nbf && payload.nbf * 1000 > now + 30000) throw new ArtifactAccessError('Artifact access token is not active', 'ACCESS_TOKEN_NOT_ACTIVE', 401);
  return payload;
}

function safeDownloadName(artifact) {
  const kind = SAFE_KIND.test(String(artifact.kind || 'artifact')) ? artifact.kind : 'artifact';
  const ext = String(artifact.media_type || '').split('/')[1]?.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'bin';
  return `forge-${kind}-${artifact.id}.${ext}`;
}

class ArtifactAccessGateway {
  constructor({ repository, storage, signingSecret = process.env.FORGE_ARTIFACT_ACCESS_SECRET, tokenTtlSeconds = Number(process.env.FORGE_ARTIFACT_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS), maxRangeBytes = Number(process.env.FORGE_ARTIFACT_MAX_RANGE_BYTES || DEFAULT_MAX_RANGE_BYTES), maxTransferBytes = Number(process.env.FORGE_ARTIFACT_MAX_TRANSFER_BYTES || DEFAULT_MAX_TRANSFER_BYTES), adminActors = process.env.FORGE_ARTIFACT_ADMIN_ACTORS || '', workerActors = process.env.FORGE_ARTIFACT_WORKER_ACTORS || '', clock = () => Date.now() } = {}) {
    if (!repository?.db?.pool) throw new TypeError('Persistent repository is required');
    if (!storage || typeof storage.download !== 'function') throw new TypeError('Storage backend is required');
    if (!signingSecret || Buffer.byteLength(signingSecret) < 32) throw new TypeError('FORGE_ARTIFACT_ACCESS_SECRET must be at least 32 bytes');
    if (!Number.isSafeInteger(tokenTtlSeconds) || tokenTtlSeconds < 30 || tokenTtlSeconds > 3600) throw new TypeError('tokenTtlSeconds must be between 30 and 3600 seconds');
    if (!Number.isSafeInteger(maxRangeBytes) || maxRangeBytes < 1 || maxRangeBytes > maxTransferBytes) throw new TypeError('maxRangeBytes is invalid');
    if (!Number.isSafeInteger(maxTransferBytes) || maxTransferBytes < 1) throw new TypeError('maxTransferBytes is invalid');
    this.repository = repository; this.storage = storage; this.signingSecret = signingSecret; this.tokenTtlSeconds = tokenTtlSeconds; this.maxRangeBytes = maxRangeBytes; this.maxTransferBytes = maxTransferBytes; this.clock = clock;
    this.adminActors = new Set(adminActors.split(',').map((v) => v.trim()).filter(Boolean));
    this.workerActors = new Set(workerActors.split(',').map((v) => v.trim()).filter(Boolean));
  }

  async _loadArtifact(artifactId) {
    const result = await this.repository.db.pool.query(`SELECT a.id,a.episode_id,a.version_id,a.kind,a.content_hash,a.media_type,a.metadata,a.created_by,a.created_at,a.lifecycle_state AS artifact_lifecycle,
      e.project_id,e.state AS episode_state,e.current_render_id,e.approved_render_id,e.published_record_id,
      s.storage_key,s.status AS storage_status,s.lifecycle_state AS storage_lifecycle,s.size_bytes,s.content_hash AS stored_hash,s.checksum_verified
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1`, [artifactId]);
    return result.rows[0] || null;
  }

  async _projectRole(projectId, actor) {
    const result = await this.repository.db.pool.query('SELECT p.created_by,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1', [projectId, actor]);
    const row = result.rows[0];
    if (!row) return null;
    return row.role || (row.created_by === actor ? 'OWNER' : null);
  }

  async _reachable(artifact) {
    const result = await this.repository.db.pool.query(`WITH RECURSIVE seeds AS (
        SELECT value AS version_id FROM episodes e, jsonb_each_text(e.current_versions) WHERE e.id=$1
        UNION SELECT version_id FROM artifacts WHERE id=$2
        UNION SELECT version_id FROM artifacts WHERE id IN (SELECT current_render_id FROM episodes WHERE id=$1 UNION SELECT approved_render_id FROM episodes WHERE id=$1)
      ), reachable AS (
        SELECT version_id FROM seeds
        UNION
        SELECT d.depends_on_version_id FROM version_dependencies d JOIN reachable r ON r.version_id=d.version_id WHERE d.episode_id=$1
      ) SELECT 1 FROM reachable WHERE version_id=$3 LIMIT 1`, [artifact.episode_id, artifact.id, artifact.version_id]);
    return Boolean(result.rows[0]);
  }

  async _authorize(artifactId, { actor, action = 'metadata', recovery = false, purpose = 'user' } = {}) {
    normalizeArtifactId(artifactId);
    if (typeof actor !== 'string' || !actor || actor.length > 255) throw new ArtifactAccessError('Actor identity is required', 'UNAUTHORIZED', 401);
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new ArtifactAccessError('Artifact not found', 'ARTIFACT_NOT_FOUND', 404);
    const admin = this.adminActors.has(actor);
    const worker = this.workerActors.has(actor);
    const role = await this._projectRole(artifact.project_id, actor);
    if (!role && !admin && !worker) throw new ArtifactAccessError('Artifact access denied', 'FORBIDDEN', 403);
    if (recovery && !admin) throw new ArtifactAccessError('Recovery access requires an artifact administrator', 'RECOVERY_FORBIDDEN', 403);
    if (!recovery && DENIED_LIFECYCLE.has(artifact.artifact_lifecycle || 'ACTIVE')) throw new ArtifactAccessError('Artifact lifecycle state does not permit access', 'ARTIFACT_LIFECYCLE_DENIED', 403);
    if (!recovery && DENIED_LIFECYCLE.has(artifact.storage_lifecycle || 'ACTIVE')) throw new ArtifactAccessError('Artifact storage lifecycle state does not permit access', 'ARTIFACT_LIFECYCLE_DENIED', 403);
    if (!['READY', null].includes(artifact.storage_status)) throw new ArtifactAccessError('Artifact storage is unavailable', artifact.storage_status === 'MISSING' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_CORRUPT', artifact.storage_status === 'MISSING' ? 404 : 503);
    if (!artifact.storage_key || !artifact.content_hash || !Number.isSafeInteger(Number(artifact.size_bytes)) || Number(artifact.size_bytes) < 0) throw new ArtifactAccessError('Artifact has no trusted storage record', 'ARTIFACT_NOT_FOUND', 404);
    if (artifact.stored_hash && artifact.stored_hash !== artifact.content_hash) throw new ArtifactAccessError('Artifact checksum metadata mismatch', 'ARTIFACT_CORRUPT', 503);
    if (!await this._reachable(artifact)) throw new ArtifactAccessError('Artifact is outside the episode provenance graph', 'PROVENANCE_DENIED', 403);
    if (['download', 'stream'].includes(action) && !recovery) {
      const internal = purpose === 'worker' && worker;
      const released = RELEASED_EPISODE_STATES.has(artifact.episode_state) && artifact.approved_render_id === artifact.id;
      if (!internal && !released) throw new ArtifactAccessError('Artifact is not approved for delivery', 'APPROVAL_REQUIRED', 403);
    }
    return { artifact, role: role || (admin ? 'ADMIN' : 'WORKER'), admin, worker };
  }

  async issueToken({ artifactId, actor, action = 'download', purpose = 'user', recovery = false }) {
    const access = await this._authorize(artifactId, { actor, action, purpose, recovery });
    const now = Math.floor(this.clock() / 1000);
    const token = signToken({ v: 1, jti: crypto.randomUUID(), artifactId: access.artifact.id, actor, action, purpose, recovery: Boolean(recovery), iat: now, nbf: now, exp: now + this.tokenTtlSeconds }, this.signingSecret);
    await this._audit(access.artifact, actor, 'ARTIFACT_ACCESS_TOKEN_ISSUED', { action, purpose, recovery: Boolean(recovery) });
    return { token, expiresAt: new Date((now + this.tokenTtlSeconds) * 1000).toISOString(), artifactId: access.artifact.id };
  }

  async resolve({ artifactId, actor, action = 'metadata', token = null, purpose = 'user', recovery = false }) {
    if (token) {
      const payload = verifyToken(token, this.signingSecret, this.clock());
      if (payload.artifactId !== artifactId || payload.actor !== actor || payload.action !== action) throw new ArtifactAccessError('Access token does not match requested artifact or action', 'TOKEN_BINDING_MISMATCH', 403);
      purpose = payload.purpose || purpose; recovery = Boolean(payload.recovery);
    }
    return this._authorize(artifactId, { actor, action, purpose, recovery });
  }

  async metadata({ artifactId, actor, token = null, recovery = false }) {
    const { artifact } = await this.resolve({ artifactId, actor, action: 'metadata', token, recovery });
    await this._audit(artifact, actor, 'ARTIFACT_METADATA_READ', {});
    return { id: artifact.id, episodeId: artifact.episode_id, projectId: artifact.project_id, versionId: artifact.version_id, kind: artifact.kind, mediaType: artifact.media_type || 'application/octet-stream', contentHash: artifact.content_hash, contentLength: Number(artifact.size_bytes), lifecycleState: artifact.artifact_lifecycle || 'ACTIVE' };
  }

  async open({ artifactId, actor, rangeHeader = null, token = null, purpose = 'user', recovery = false }) {
    const action = rangeHeader ? 'stream' : 'download';
    const { artifact } = await this.resolve({ artifactId, actor, action, token, purpose, recovery });
    const sizeBytes = Number(artifact.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > this.maxTransferBytes) throw new ArtifactAccessError('Artifact exceeds configured transfer limit', 'TRANSFER_TOO_LARGE', 413);
    const range = parseRange(rangeHeader, sizeBytes, this.maxRangeBytes);
    let resolved;
    try {
      if (range && typeof this.storage.downloadRange === 'function') resolved = await this.storage.downloadRange({ key: artifact.storage_key, start: range.start, end: range.end, expectedSha256: artifact.content_hash });
      else if (range) throw new ArtifactAccessError('Range delivery is unavailable for this storage backend', 'RANGE_UNSUPPORTED', 416);
      else resolved = await this.storage.download({ key: artifact.storage_key, expectedSha256: artifact.content_hash, maxBytes: this.maxTransferBytes });
    } catch (error) {
      if (error instanceof ArtifactAccessError) throw error;
      const code = error.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND' : error.code === 'CHECKSUM_MISMATCH' || error.code === 'STORAGE_CORRUPT' ? 'ARTIFACT_CORRUPT' : 'STORAGE_PROVIDER_ERROR';
      await this.repository.db.pool.query('UPDATE storage_objects SET status=$1 WHERE artifact_id=$2', [code === 'ARTIFACT_NOT_FOUND' ? 'MISSING' : code === 'ARTIFACT_CORRUPT' ? 'CORRUPT' : 'READY', artifact.id]).catch(() => {});
      throw new ArtifactAccessError('Artifact delivery failed', code, code === 'ARTIFACT_NOT_FOUND' ? 404 : 503);
    }
    const actualLength = range ? range.length : Number(resolved.sizeBytes);
    if (actualLength !== (range ? range.length : sizeBytes)) throw new ArtifactAccessError('Stored content length does not match trusted artifact metadata', 'CONTENT_LENGTH_MISMATCH', 503);
    await this._audit(artifact, actor, range ? 'ARTIFACT_STREAM' : 'ARTIFACT_DOWNLOAD', { bytes: actualLength, ranged: Boolean(range), start: range?.start ?? 0, end: range?.end ?? sizeBytes - 1, purpose });
    return { artifact, stream: resolved.stream, statusCode: range ? 206 : 200, contentLength: actualLength, contentRange: range ? `bytes ${range.start}-${range.end}/${sizeBytes}` : null, contentType: artifact.media_type || 'application/octet-stream', contentDisposition: `attachment; filename="${safeDownloadName(artifact)}"`, etag: `"sha256-${artifact.content_hash}"`, acceptRanges: 'bytes' };
  }

  async _audit(artifact, actor, action, details) {
    await this.repository.db.pool.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,'artifact',$5,$6::jsonb)`, [artifact.project_id, artifact.episode_id, actor, action, artifact.id, JSON.stringify({ ...details, artifactVersionId: artifact.version_id })]).catch(() => {});
  }
}

module.exports = { ArtifactAccessGateway, ArtifactAccessError, parseRange, signToken, verifyToken, normalizeArtifactId, safeDownloadName };
