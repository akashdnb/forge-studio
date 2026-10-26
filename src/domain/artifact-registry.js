const crypto = require('node:crypto');
const { immutableRecord, requiredString } = require('./records');

class ArtifactRegistry {
  #artifacts = new Map();
  #byEpisode = new Map();

  register({
    id, episodeId, kind, versionId, storageUri = null, content = null, contentHash = null,
    mediaType = null, providerRunId = null, source = 'forge', license = null,
    inputVersionIds = [], metadata = {}, createdBy = 'system',
  }) {
    id = requiredString(id, 'id');
    episodeId = requiredString(episodeId, 'episodeId');
    kind = requiredString(kind, 'kind');
    versionId = requiredString(versionId, 'versionId');
    if (this.#artifacts.has(id)) throw new Error(`Artifact already exists: ${id}`);
    if (!storageUri && content === null) throw new TypeError('storageUri or content is required');
    const serializedContent = content === null ? null : JSON.stringify(content);
    const digest = contentHash || (serializedContent !== null
      ? crypto.createHash('sha256').update(serializedContent).digest('hex') : null);
    const now = new Date().toISOString();
    const artifact = immutableRecord({
      id, episodeId, kind, versionId, storageUri, content: content === null ? null : content,
      contentHash: digest, mediaType, providerRunId, source, license,
      inputVersionIds: [...new Set(inputVersionIds)], metadata, createdBy, createdAt: now,
    });
    this.#artifacts.set(id, artifact);
    if (!this.#byEpisode.has(episodeId)) this.#byEpisode.set(episodeId, []);
    this.#byEpisode.get(episodeId).push(id);
    return artifact;
  }

  get(id) { return this.#artifacts.get(id); }
  listByEpisode(episodeId) {
    return (this.#byEpisode.get(episodeId) || []).map((id) => this.#artifacts.get(id));
  }
  verifyContent(id, content) {
    const artifact = this.#artifacts.get(id);
    if (!artifact) throw new Error(`Unknown artifact: ${id}`);
    if (!artifact.contentHash) return null;
    const digest = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return { valid: digest === artifact.contentHash, expected: artifact.contentHash, actual: digest };
  }
}
module.exports = { ArtifactRegistry };
