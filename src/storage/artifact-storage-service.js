const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { FailureInjector } = require('../chaos/failure-injector');
const { getActiveObservability } = require('../observability');
const { ArtifactIntegrityControlPlane } = require('./artifact-integrity-control-plane');

const SUPPORTED_KINDS = new Set([
  'render', 'render-manifest', 'audio', 'image', 'video', 'caption', 'package',
  'derivative:poster', 'derivative:contact-sheet', 'derivative:waveform',
  'derivative:proxy', 'derivative:clip'
]);

class ArtifactStorageService {
  constructor({ storage, repository, injector = FailureInjector.fromEnv(), observability = null }) {
    if (!storage || typeof storage.upload !== 'function' || typeof storage.download !== 'function') throw new TypeError('storage backend is required');
    if (!repository?.db) throw new TypeError('persistent repository is required');
    this.storage = storage;
    this.repository = repository;
    this.injector = injector;
    this.observability = observability || getActiveObservability();
  }

  async _tenantForProject(projectId, tenantId = null) {
    const project = (await this.repository.db.pool.query('SELECT id,tenant_id FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) throw Object.assign(new Error('Project not found'), { code: 'PROJECT_NOT_FOUND' });
    if (tenantId && project.tenant_id !== tenantId) throw Object.assign(new Error('Artifact tenant/project mismatch'), { code: 'TENANT_SCOPE_VIOLATION' });
    return project.tenant_id;
  }

  async putArtifact({ episodeId, projectId, tenantId = null, versionId, kind, stream, content, contentType = 'application/octet-stream', expectedSha256, metadata = {}, artifactId = randomUUID(), createdBy = 'worker', inputVersionIds = [], providerRunId = null, source = 'forge', license = null }) {
    if (!SUPPORTED_KINDS.has(kind)) throw new TypeError(`Unsupported stored artifact kind: ${kind}`);
    if (!episodeId || !projectId || !versionId) throw new TypeError('episodeId, projectId and versionId are required');
    if (!stream) {
      if (content == null) throw new TypeError('stream or content is required');
      stream = Buffer.isBuffer(content) ? Readable.from(content) : Readable.from([Buffer.from(content)]);
    }
    const episode = await this.repository.db.getEpisode(episodeId);
    const episodeProjectId = episode?.project_id || episode?.projectId;
    if (!episode || episodeProjectId !== projectId) throw Object.assign(new Error('Artifact project/episode mismatch'), { code: 'INVALID_PROVENANCE' });
    const resolvedTenantId = await this._tenantForProject(projectId, tenantId);
    const existing = await this.repository.db.pool.query('SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2', [artifactId, episodeId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.version_id !== versionId || row.kind !== kind) throw Object.assign(new Error('Artifact idempotency key conflicts with immutable artifact identity'), { code: 'IDEMPOTENCY_CONFLICT' });
      const storedObject = await this.repository.db.pool.query('SELECT status,content_hash FROM storage_objects WHERE artifact_id=$1', [artifactId]);
      if (storedObject.rows[0]?.status === 'READY' && storedObject.rows[0].content_hash === row.content_hash) {
        this.observability?.metrics.inc('forge_artifact_io_total', { outcome: 'deduplicated' });
        await this._recordLineage(artifactId, inputVersionIds, createdBy);
        if (this.repository.provenanceGraph) await this.repository.provenanceGraph().ensureArtifactChain({ artifactId, actor: createdBy, reason: 'artifact-deduplicated' });
        return row;
      }
    }
    await this.injector.trip('artifact.before_upload', { jobId: artifactId, retryable: true });
    const started = Date.now();
    const upload = () => this.storage.upload({ stream, tenantId: resolvedTenantId, projectId, kind, contentType, expectedSha256, metadata });
    const stored = await (this.observability ? this.observability.withSpan(`artifact.upload:${kind}`, { episodeId, artifactId }, upload) : upload());
    this.observability?.metrics.inc('forge_artifact_io_total', { outcome: 'upload' });
    this.observability?.metrics.observe('forge_artifact_upload_duration_seconds', { stage: kind }, (Date.now() - started) / 1000);
    this.observability?.metrics.inc('forge_artifact_bytes_total', { outcome: 'upload' }, stored.sizeBytes || 0);
    try {
      await this.injector.trip('artifact.after_upload', { jobId: artifactId, retryable: true });
      const artifact = existing.rows[0] ? existing.rows[0] : await this.repository.registerArtifact({
        id: artifactId, episodeId, kind, versionId, storageUri: stored.uri, contentHash: stored.sha256,
        mediaType: contentType, providerRunId, source, license, inputVersionIds, metadata: { ...metadata, storageKey: stored.key, sizeBytes: stored.sizeBytes }, createdBy
      });
      if (artifact.content_hash && artifact.content_hash !== stored.sha256) throw Object.assign(new Error('Artifact content hash conflicts with uploaded immutable content'), { code: 'IDEMPOTENCY_CONFLICT' });
      await this.repository.db.withTransaction(async (client) => {
        const project = (await client.query('SELECT tenant_id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rows[0];
        if (!project || project.tenant_id !== resolvedTenantId) throw Object.assign(new Error('Tenant/project scope changed during artifact publication'), { code: 'TENANT_SCOPE_VIOLATION' });
        await client.query(`INSERT INTO storage_objects(id,project_id,artifact_id,uri,storage_key,kind,content_hash,media_type,size_bytes,checksum_verified,status,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'READY',$10::jsonb)
          ON CONFLICT (artifact_id) DO UPDATE SET uri=EXCLUDED.uri,storage_key=EXCLUDED.storage_key,kind=EXCLUDED.kind,content_hash=EXCLUDED.content_hash,media_type=EXCLUDED.media_type,size_bytes=EXCLUDED.size_bytes,checksum_verified=true,status='READY',metadata=EXCLUDED.metadata`,
          [randomUUID(), projectId, artifactId, stored.uri, stored.key, kind, stored.sha256, contentType, stored.sizeBytes, JSON.stringify({ ...metadata, tenantId: resolvedTenantId })]);
      });
      await this._recordLineage(artifactId, inputVersionIds, createdBy);
      if (this.repository.provenanceGraph) await this.repository.provenanceGraph().ensureArtifactChain({ artifactId, actor: createdBy, reason: 'artifact-storage-ready' });
      return artifact;
    } catch (error) {
      this.observability?.metrics.inc('forge_artifact_io_total', { outcome: 'upload_failed' });
      error.storageKey = undefined;
      throw error;
    }
  }

  async _recordLineage(artifactId, inputVersionIds, actor) {
    const versions = [...new Set(Array.isArray(inputVersionIds) ? inputVersionIds.filter(Boolean) : [])];
    if (!versions.length) return;
    const artifact = (await this.repository.db.pool.query(`SELECT a.id,e.episode_id,e.project_id,p.tenant_id
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1`, [artifactId])).rows[0];
    if (!artifact) throw Object.assign(new Error('artifact not found for lineage'), { code: 'ARTIFACT_NOT_FOUND' });
    const parents = (await this.repository.db.pool.query(`SELECT DISTINCT ON (a.version_id) a.id,a.version_id
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      WHERE a.version_id=ANY($1::text[]) AND e.episode_id=$2 AND p.id=$3 AND p.tenant_id=$4
      ORDER BY a.version_id,a.created_at DESC,a.id`, [versions, artifact.episode_id, artifact.project_id, artifact.tenant_id])).rows;
    const controlPlane = new ArtifactIntegrityControlPlane({ pool: this.repository.db.pool, storage: this.storage, logger: this.repository.logger || console, metrics: this.observability?.metrics });
    for (const parent of parents) await controlPlane.recordArtifactLineage({ childArtifactId: artifact.id, parentArtifactId: parent.id, relation: 'DERIVED_FROM', actor, evidence: { inputVersionId: parent.version_id } });
  }

  async openArtifact({ artifactId, projectId, expectedVersionId }) {
    const result = await this.repository.db.pool.query(`SELECT a.*, e.project_id, p.tenant_id, s.storage_key, s.status, s.content_hash AS stored_hash
      FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
      LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1 AND e.project_id=$2`, [artifactId, projectId]);
    const artifact = result.rows[0];
    if (!artifact) {
      this.observability?.metrics.inc('forge_artifact_io_total', { outcome: 'not_found' });
      throw Object.assign(new Error('Artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
    }
    if (expectedVersionId && artifact.version_id !== expectedVersionId) throw Object.assign(new Error('Artifact version mismatch'), { code: 'INVALID_PROVENANCE' });
    if (!artifact.storage_key || !artifact.content_hash) throw Object.assign(new Error('Artifact has no trusted storage record'), { code: 'ARTIFACT_NOT_FOUND' });
    if (artifact.status && artifact.status !== 'READY') throw Object.assign(new Error(`Artifact storage is ${artifact.status.toLowerCase()}`), { code: artifact.status === 'MISSING' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_CORRUPT' });
    if (artifact.stored_hash && artifact.stored_hash !== artifact.content_hash) throw Object.assign(new Error('Artifact storage checksum metadata mismatch'), { code: 'ARTIFACT_CORRUPT' });
    const started = Date.now();
    try {
      const download = () => this.storage.download({ key: artifact.storage_key, expectedSha256: artifact.content_hash });
      const resolved = await (this.observability ? this.observability.withSpan(`artifact.download:${artifact.kind}`, { artifactId }, download) : download());
      this.observability?.metrics.inc('forge_artifact_io_total', { outcome: 'download' });
      this.observability?.metrics.observe('forge_artifact_download_duration_seconds', { stage: artifact.kind }, (Date.now() - started) / 1000);
      this.observability?.metrics.inc('forge_artifact_bytes_total', { outcome: 'download' }, resolved.sizeBytes || 0);
      return { ...resolved, artifactId: artifact.id, versionId: artifact.version_id, kind: artifact.kind, mediaType: artifact.media_type, metadata: artifact.metadata || {} };
    } catch (error) {
      const code = error.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_CORRUPT';
      await this.repository.db.pool.query('UPDATE storage_objects SET status=$1 WHERE artifact_id=$2', [code === 'ARTIFACT_NOT_FOUND' ? 'MISSING' : 'CORRUPT', artifactId]).catch(() => {});
      if (this.repository.provenanceGraph) await this.repository.provenanceGraph().ensureArtifactChain({ artifactId, actor: 'artifact-gateway', reason: `storage-${code.toLowerCase()}` }).catch(() => {});
      this.observability?.metrics.inc('forge_artifact_io_total', { outcome: code === 'ARTIFACT_NOT_FOUND' ? 'missing' : 'corrupt' });
      throw Object.assign(error, { code });
    }
  }
}

module.exports = { ArtifactStorageService, SUPPORTED_KINDS };