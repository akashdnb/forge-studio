const { immutableRecord, requiredString } = require('./records');

const APPROVAL_STAGES = Object.freeze(['SCRIPT', 'SCENE_PLAN', 'CREATIVE', 'FINAL_RENDER']);
const DECISIONS = Object.freeze(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED']);

class ApprovalService {
  #records = new Map();
  #latestByTarget = new Map();

  decide({ id, episodeId, stage, targetId, targetVersionId, decision, actor, comments = '', evidence = {} }) {
    id = requiredString(id, 'id');
    episodeId = requiredString(episodeId, 'episodeId');
    targetId = requiredString(targetId, 'targetId');
    targetVersionId = requiredString(targetVersionId, 'targetVersionId');
    actor = requiredString(actor, 'actor');
    if (!APPROVAL_STAGES.includes(stage)) throw new Error(`Unknown approval stage: ${stage}`);
    if (!DECISIONS.includes(decision)) throw new Error(`Unknown approval decision: ${decision}`);
    if (this.#records.has(id)) throw new Error(`Approval record already exists: ${id}`);
    const now = new Date().toISOString();
    const record = immutableRecord({ id, episodeId, stage, targetId, targetVersionId, decision, actor, comments, evidence, decidedAt: now });
    this.#records.set(id, record);
    this.#latestByTarget.set(`${episodeId}:${stage}:${targetId}`, id);
    return record;
  }

  get(id) { return this.#records.get(id); }
  historyForTarget({ episodeId, stage, targetId }) {
    return [...this.#records.values()].filter((r) =>
      r.episodeId === episodeId && r.stage === stage && r.targetId === targetId);
  }
  latestForTarget({ episodeId, stage, targetId }) {
    const id = this.#latestByTarget.get(`${episodeId}:${stage}:${targetId}`);
    return id ? this.#records.get(id) : undefined;
  }
  isApproved({ episodeId, stage, targetId, targetVersionId }) {
    const latest = this.latestForTarget({ episodeId, stage, targetId });
    return Boolean(latest && latest.decision === 'APPROVED' && latest.targetVersionId === targetVersionId);
  }
}

module.exports = { ApprovalService, APPROVAL_STAGES, DECISIONS };
