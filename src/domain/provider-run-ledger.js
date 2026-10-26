const { immutableRecord, requiredString, finiteNonNegative } = require('./records');

const RUN_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

class ProviderRunLedger {
  #runs = new Map();
  #idempotency = new Map();
  #costs = new Map();

  start({ id, episodeId, capability, provider, model = null, inputVersionIds = [], idempotencyKey, request = {}, attempt = 1 }) {
    id = requiredString(id, 'id');
    episodeId = requiredString(episodeId, 'episodeId');
    capability = requiredString(capability, 'capability');
    provider = requiredString(provider, 'provider');
    idempotencyKey = requiredString(idempotencyKey, 'idempotencyKey');
    if (this.#idempotency.has(idempotencyKey)) return this.#runs.get(this.#idempotency.get(idempotencyKey));
    if (this.#runs.has(id)) throw new Error(`Provider run already exists: ${id}`);
    if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer');
    const run = immutableRecord({
      id, episodeId, capability, provider, model, inputVersionIds: [...new Set(inputVersionIds)],
      idempotencyKey, request, attempt, status: 'QUEUED', externalJobId: null, resultArtifactIds: [],
      usage: {}, estimatedCost: null, actualCost: null, currency: 'USD', error: null,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    });
    this.#runs.set(id, run);
    this.#idempotency.set(idempotencyKey, id);
    return run;
  }

  get(id) { return this.#runs.get(id); }
  listByEpisode(episodeId) { return [...this.#runs.values()].filter((r) => r.episodeId === episodeId); }

  transition(id, status, patch = {}) {
    const current = this.#runs.get(id);
    if (!current) throw new Error(`Unknown provider run: ${id}`);
    if (!RUN_STATUSES.includes(status)) throw new Error(`Unknown provider run status: ${status}`);
    if (TERMINAL.has(current.status)) throw new Error('Terminal provider runs are immutable');
    const allowed = {
      QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
      RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    };
    if (!allowed[current.status].includes(status)) throw new Error(`Illegal provider-run transition: ${current.status} -> ${status}`);
    const now = new Date().toISOString();
    const next = immutableRecord({
      ...current, ...patch, status,
      startedAt: status === 'RUNNING' ? now : current.startedAt,
      finishedAt: TERMINAL.has(status) ? now : null,
    });
    this.#runs.set(id, next);
    return next;
  }

  recordCost({
    id, runId, episodeId, provider, model = null, operation, inputUnits = 0, outputUnits = 0,
    estimatedCost = null, actualCost = null, currency = 'USD', isRetry = false, metadata = {},
  }) {
    id = requiredString(id, 'id');
    runId = requiredString(runId, 'runId');
    episodeId = requiredString(episodeId, 'episodeId');
    if (this.#costs.has(id)) throw new Error(`Cost record already exists: ${id}`);
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`Unknown provider run: ${runId}`);
    if (run.episodeId !== episodeId) throw new Error('Cost record episode must match provider run');
    inputUnits = finiteNonNegative(inputUnits, 'inputUnits');
    outputUnits = finiteNonNegative(outputUnits, 'outputUnits');
    if (estimatedCost !== null) finiteNonNegative(estimatedCost, 'estimatedCost');
    if (actualCost !== null) finiteNonNegative(actualCost, 'actualCost');
    const record = immutableRecord({
      id, runId, episodeId, provider: requiredString(provider, 'provider'), model,
      operation: requiredString(operation, 'operation'), inputUnits, outputUnits,
      estimatedCost, actualCost, currency: requiredString(currency, 'currency').toUpperCase(),
      isRetry: Boolean(isRetry), metadata, createdAt: new Date().toISOString(),
    });
    this.#costs.set(id, record);
    return record;
  }

  costsByEpisode(episodeId) {
    return [...this.#costs.values()].filter((r) => r.episodeId === episodeId);
  }

  episodeCost(episodeId) {
    const records = this.costsByEpisode(episodeId);
    const currencies = [...new Set(records.map((r) => r.currency))];
    const totals = Object.fromEntries(currencies.map((currency) => [currency, {
      estimated: records.filter((r) => r.currency === currency && r.estimatedCost !== null)
        .reduce((sum, r) => sum + r.estimatedCost, 0),
      actual: records.filter((r) => r.currency === currency && r.actualCost !== null)
        .reduce((sum, r) => sum + r.actualCost, 0),
      estimatedRecords: records.filter((r) => r.currency === currency && r.estimatedCost !== null).length,
      actualRecords: records.filter((r) => r.currency === currency && r.actualCost !== null).length,
    }]));
    return { episodeId, recordCount: records.length, currencies: totals };
  }
}

module.exports = { ProviderRunLedger, RUN_STATUSES };
