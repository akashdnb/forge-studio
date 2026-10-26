/**
 * Forge's product-owned version graph.
 *
 * Versions are immutable records. Dependencies point from a derived version
 * to the versions it consumed. Invalidation walks the reverse dependency
 * graph so only affected descendants need regeneration.
 */

const VERSION_KINDS = Object.freeze([
  'episode',
  'script',
  'scene-plan',
  'scene',
  'asset',
  'narration',
  'render',
  'qa',
]);

function assertKind(kind) {
  if (!VERSION_KINDS.includes(kind)) {
    throw new Error(`Unsupported version kind: ${kind}`);
  }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

class VersionGraph {
  #versions = new Map();
  #children = new Map();
  #current = new Map();

  addVersion({ id, episodeId, kind, payload = {}, dependencies = [], parentId = null }) {
    if (!id || !episodeId) throw new Error('id and episodeId are required');
    assertKind(kind);
    if (this.#versions.has(id)) throw new Error(`Version already exists: ${id}`);
    if (parentId && !this.#versions.has(parentId)) {
      throw new Error(`Parent version does not exist: ${parentId}`);
    }

    const uniqueDependencies = [...new Set(dependencies)];
    for (const dependencyId of uniqueDependencies) {
      const dependency = this.#versions.get(dependencyId);
      if (!dependency) throw new Error(`Dependency version does not exist: ${dependencyId}`);
      if (dependency.episodeId !== episodeId) {
        throw new Error(`Cross-episode dependency: ${dependencyId}`);
      }
    }

    const version = freeze({
      id,
      episodeId,
      kind,
      payload: freeze({ ...payload }),
      dependencies: freeze(uniqueDependencies),
      parentId,
    });

    this.#versions.set(id, version);
    this.#children.set(id, new Set());
    for (const dependencyId of uniqueDependencies) {
      this.#children.get(dependencyId).add(id);
    }
    if (parentId) this.#children.get(parentId).add(id);
    return version;
  }

  get(id) {
    return this.#versions.get(id);
  }

  setCurrent(episodeId, versionId) {
    const version = this.#versions.get(versionId);
    if (!version || version.episodeId !== episodeId) {
      throw new Error(`Version ${versionId} does not belong to episode ${episodeId}`);
    }
    this.#current.set(episodeId, versionId);
  }

  getCurrent(episodeId) {
    const id = this.#current.get(episodeId);
    return id ? this.#versions.get(id) : undefined;
  }

  descendantsOf(versionId) {
    if (!this.#versions.has(versionId)) throw new Error(`Unknown version: ${versionId}`);
    const result = new Set();
    const queue = [...this.#children.get(versionId)];
    while (queue.length) {
      const id = queue.shift();
      if (result.has(id)) continue;
      result.add(id);
      queue.push(...this.#children.get(id));
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
}

module.exports = { VERSION_KINDS, VersionGraph };
