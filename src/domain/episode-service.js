const { immutableRecord, requiredString } = require('./records');

const EPISODE_STATES = Object.freeze([
  'DRAFT', 'RESEARCHING', 'SCRIPT_DRAFT', 'SCRIPT_REVIEW', 'SCRIPT_APPROVED',
  'PLANNING', 'PLAN_REVIEW', 'GENERATION', 'READY_TO_RENDER', 'RENDERING',
  'QA', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'PUBLISHED',
  'FAILED', 'CANCELLED',
]);

const TRANSITIONS = Object.freeze({
  DRAFT: ['RESEARCHING', 'SCRIPT_DRAFT', 'CANCELLED'],
  RESEARCHING: ['SCRIPT_DRAFT', 'FAILED', 'CANCELLED'],
  SCRIPT_DRAFT: ['SCRIPT_REVIEW', 'FAILED', 'CANCELLED'],
  SCRIPT_REVIEW: ['SCRIPT_APPROVED', 'SCRIPT_DRAFT', 'CANCELLED'],
  SCRIPT_APPROVED: ['PLANNING', 'CANCELLED'],
  PLANNING: ['PLAN_REVIEW', 'FAILED', 'CANCELLED'],
  PLAN_REVIEW: ['GENERATION', 'PLANNING', 'CANCELLED'],
  GENERATION: ['READY_TO_RENDER', 'FAILED', 'CANCELLED'],
  READY_TO_RENDER: ['RENDERING', 'GENERATION', 'CANCELLED'],
  RENDERING: ['QA', 'FAILED', 'CANCELLED'],
  QA: ['AWAITING_APPROVAL', 'GENERATION', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'GENERATION', 'CANCELLED'],
  APPROVED: ['PUBLISHING', 'GENERATION', 'CANCELLED'],
  PUBLISHING: ['PUBLISHED', 'APPROVED', 'FAILED'],
  PUBLISHED: [],
  FAILED: ['RESEARCHING', 'SCRIPT_DRAFT', 'PLANNING', 'GENERATION', 'RENDERING', 'PUBLISHING', 'CANCELLED'],
  CANCELLED: [],
});

class EpisodeService {
  #episodes = new Map();

  create({ id, projectId, channelId = null, title, description = '', createdBy = 'system', metadata = {} }) {
    id = requiredString(id, 'id');
    projectId = requiredString(projectId, 'projectId');
    title = requiredString(title, 'title');
    if (this.#episodes.has(id)) throw new Error(`Episode already exists: ${id}`);
    const now = new Date().toISOString();
    const episode = immutableRecord({
      id, projectId, channelId, title, description, createdBy, metadata,
      state: 'DRAFT', revision: 1, createdAt: now, updatedAt: now,
      currentVersions: {}, currentRenderId: null, approvedRenderId: null, publishedRecordId: null,
    });
    this.#episodes.set(id, episode);
    return episode;
  }

  get(id) { return this.#episodes.get(id); }

  list({ projectId } = {}) {
    return [...this.#episodes.values()].filter((e) => !projectId || e.projectId === projectId);
  }

  transition(id, nextState, { actor = 'system', reason = null, expectedRevision } = {}) {
    const current = this.#episodes.get(id);
    if (!current) throw new Error(`Unknown episode: ${id}`);
    if (!EPISODE_STATES.includes(nextState)) throw new Error(`Unknown episode state: ${nextState}`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error('Episode revision conflict');
    }
    if (!TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`Illegal episode transition: ${current.state} -> ${nextState}`);
    }
    const updated = immutableRecord({
      ...current, state: nextState, revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      transitionHistory: [...(current.transitionHistory || []), {
        from: current.state, to: nextState, actor, reason, at: new Date().toISOString(),
      }],
      ...(nextState !== 'APPROVED' ? { approvedRenderId: current.approvedRenderId } : {}),
    });
    this.#episodes.set(id, updated);
    return updated;
  }

  updateCurrentVersion(id, kind, versionId, { expectedRevision } = {}) {
    const current = this.#episodes.get(id);
    if (!current) throw new Error(`Unknown episode: ${id}`);
    if (!kind || !versionId) throw new TypeError('kind and versionId are required');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Episode revision conflict');
    const currentVersions = { ...current.currentVersions, [kind]: versionId };
    // Any upstream selection change invalidates final approval. Approved records stay in history.
    const updated = immutableRecord({
      ...current, currentVersions, approvedRenderId: null,
      revision: current.revision + 1, updatedAt: new Date().toISOString(),
    });
    this.#episodes.set(id, updated);
    return updated;
  }

  selectRender(id, renderId, { expectedRevision } = {}) {
    const current = this.#episodes.get(id);
    if (!current) throw new Error(`Unknown episode: ${id}`);
    if (!renderId) throw new TypeError('renderId is required');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Episode revision conflict');
    const updated = immutableRecord({
      ...current, currentRenderId: renderId, approvedRenderId: null,
      revision: current.revision + 1, updatedAt: new Date().toISOString(),
    });
    this.#episodes.set(id, updated);
    return updated;
  }

  markApproved(id, renderId, { expectedRevision } = {}) {
    const current = this.#episodes.get(id);
    if (!current) throw new Error(`Unknown episode: ${id}`);
    if (current.state !== 'AWAITING_APPROVAL') throw new Error('Episode is not awaiting approval');
    if (current.currentRenderId !== renderId) throw new Error('Only the currently selected render can be approved');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Episode revision conflict');
    const approved = immutableRecord({
      ...current, approvedRenderId: renderId, state: 'APPROVED',
      revision: current.revision + 1, updatedAt: new Date().toISOString(),
    });
    this.#episodes.set(id, approved);
    return approved;
  }

  markPublished(id, publishRecordId) {
    const current = this.#episodes.get(id);
    if (!current) throw new Error(`Unknown episode: ${id}`);
    if (current.state !== 'PUBLISHING') throw new Error('Episode is not publishing');
    if (!current.approvedRenderId) throw new Error('Episode has no approved render');
    const updated = immutableRecord({
      ...current, state: 'PUBLISHED', publishedRecordId: requiredString(publishRecordId, 'publishRecordId'),
      revision: current.revision + 1, updatedAt: new Date().toISOString(),
    });
    this.#episodes.set(id, updated);
    return updated;
  }
}

module.exports = { EpisodeService, EPISODE_STATES, TRANSITIONS };
