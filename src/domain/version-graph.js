/**
 * Forge's product-owned version graph.
 * Edges point from a derived version to the versions it consumed.
 */
const { immutableRecord, requiredString } = require('./records');

const VERSION_KINDS = Object.freeze([
  'episode', 'research', 'script', 'scene-plan', 'scene', 'asset', 'narration',
  'timeline', 'render', 'qa', 'caption', 'thumbnail', 'publish-record',
]);

function assertKind(kind) {
  if (!VERSION_KINDS.includes(kind)) throw new Error(`Unsupported version kind: ${kind}`);
}

class VersionGraph {
  #versions = new Map();
  #children = new Map();
  #current = new Map();

  addVersion({ id, episodeId, kind, payload = {}, dependencies = [], parentId = null }) {
    id = requiredString(id, 'id');
    episodeId = requiredString(episodeId, 'episodeId');
    assertKind(kind);
    if (this.#versions.has(id)) throw new Error(`Version already exists: ${id}`);
    const uniqueDependencies = [...new Set(dependencies)];
    const dependencyIds = new Set(uniqueDependencies);
    if (parentId) dependencyIds.add(parentId);
    for (const dependencyId of dependencyIds) {
      const dependency = this.#versions.get(dependencyId);
      if (!dependency) throw new Error(`Dependency version does not exist: ${dependencyId}`);
      if (dependency.episodeId !== episodeId) throw new Error(`Cross-episode dependency: ${dependencyId}`);
    }
    if (uniqueDependencies.includes(id) || parentId === id) throw new Error('Version cannot depend on itself');
    const version = immutableRecord({ id, episodeId, kind, payload, dependencies: uniqueDependencies, parentId });
    this.#versions.set(id, version);
    this.#children.set(id, new Set());
    for (const dependencyId of dependencyIds) this.#children.get(dependencyId).add(id);
    return version;
  }

  get(id) { return this.#versions.get(id); }

  setCurrent(episodeId, versionId) {
    const version = this.#versions.get(versionId);
    if (!version || version.episodeId !== episodeId) throw new Error(`Version ${versionId} does not belong to episode ${episodeId}`);
    this.#current.set(episodeId, versionId);
  }

  getCurrent(episodeId) {
    const id = this.#current.get(episodeId);
    return id ? this.#versions.get(id) : undefined;
  }

  descendantsOf(versionId) {
    if (!this.#versions.has(versionId)) throw new Error(`Unknown version: ${versionId}`);
    const result = new Set();
    const queue = [...(this.#children.get(versionId) || [])];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      if (result.has(id)) continue;
      result.add(id);
      queue.push(...(this.#children.get(id) || []));
    }
    return [...result];
  }

  invalidationPlan(changedVersionIds) {
    const affected = new Set();
    for (const id of changedVersionIds) {
      if (!this.#versions.has(id)) throw new Error(`Unknown version: ${id}`);
      for (const descendant of this.descendantsOf(id)) affected.add(descendant);
    }
    return [...affected].map((id) => this.#versions.get(id));
  }

  listByEpisode(episodeId) { return [...this.#versions.values()].filter((v) => v.episodeId === episodeId); }
}

module.exports = { VERSION_KINDS, VersionGraph };
