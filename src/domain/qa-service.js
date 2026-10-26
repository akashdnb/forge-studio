const { immutableRecord, requiredString } = require('./records');

const QA_STATUSES = Object.freeze(['PASSED', 'WARNINGS', 'FAILED']);

class QAService {
  #results = new Map();

  record({ id, episodeId, artifactId, versionId, checks = [], runner = 'forge-core', metadata = {} }) {
    id = requiredString(id, 'id');
    episodeId = requiredString(episodeId, 'episodeId');
    artifactId = requiredString(artifactId, 'artifactId');
    versionId = requiredString(versionId, 'versionId');
    if (this.#results.has(id)) throw new Error(`QA result already exists: ${id}`);
    const normalized = checks.map((check, index) => {
      if (!check || typeof check.name !== 'string' || !check.name.trim()) throw new TypeError(`checks[${index}].name is required`);
      if (!['PASS', 'WARN', 'FAIL', 'SKIP'].includes(check.status)) throw new TypeError(`checks[${index}].status is invalid`);
      return { name: check.name.trim(), status: check.status, message: check.message || '', details: check.details || {} };
    });
    const status = normalized.some((c) => c.status === 'FAIL') ? 'FAILED'
      : normalized.some((c) => c.status === 'WARN') ? 'WARNINGS' : 'PASSED';
    const result = immutableRecord({
      id, episodeId, artifactId, versionId, runner, checks: normalized, status, metadata,
      createdAt: new Date().toISOString(),
    });
    this.#results.set(id, result);
    return result;
  }

  get(id) { return this.#results.get(id); }
  latestForArtifact(artifactId) {
    return [...this.#results.values()].filter((r) => r.artifactId === artifactId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  canApprove(artifactId, versionId) {
    const latest = this.latestForArtifact(artifactId);
    return Boolean(latest && latest.versionId === versionId && latest.status !== 'FAILED');
  }
}

module.exports = { QAService, QA_STATUSES };
