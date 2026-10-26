const crypto = require('node:crypto');
const { requiredString } = require('./records');

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function snapshot(value) {
  if (value === undefined) return undefined;
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

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
    const contentSnapshot = content === null ? null : snapshot(content);
    const contentDigest = contentSnapshot === null ? null : digest(contentSnapshot);
    if (contentHash && contentDigest && contentHash !== contentDigest) throw new Error('Provided contentHash does not match content');
    const artifact = snapshot({
      id, episodeId, kind, versionId, storageUri, content: contentSnapshot,
      contentHash: contentHash || contentDigest, mediaType, providerRunId, source, license,
      inputVersionIds: [...new Set(inputVersionIds)], metadata: snapshot(metadata), createdBy,
      createdAt: new Date().toISOString(),
    });
    this.#artifacts.set(id, artifact);
    if (!this.#byEpisode.has(episodeId)) this.#byEpisode.set(episodeId, []);
    this.#byEpisode.get(episodeId).push(id);
    return snapshot(artifact);
  }

  get(id) { const value = this.#artifacts.get(id); return value ? snapshot(value) : undefined; }
  listByEpisode(episodeId) {
    return (this.#byEpisode.get(episodeId) || []).map((id) => snapshot(this.#artifacts.get(id)));
  }
  verifyContent(id, content) {
    const artifact = this.#artifacts.get(id);
    if (!artifact) throw new Error(`Unknown artifact: ${id}`);
    if (!artifact.contentHash) return null;
    const actual = digest(content);
    return { valid: actual === artifact.contentHash, expected: artifact.contentHash, actual };
  }
}
module.exports = { ArtifactRegistry };
