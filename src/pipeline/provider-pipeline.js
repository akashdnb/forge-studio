const { immutableRecord, requiredString } = require('./records');

const PIPELINE_STAGES = Object.freeze([
  'RESEARCH', 'SCRIPT', 'SCENE_PLAN', 'NARRATION', 'ASSETS', 'TIMELINE', 'RENDER', 'QA', 'PUBLISH',
]);

class ProviderRegistry {
  #providers = new Map();

  register(capability, provider) {
    capability = requiredString(capability, 'capability');
    if (!provider || typeof provider.execute !== 'function') throw new TypeError('provider.execute(request, context) is required');
    if (this.#providers.has(capability)) throw new Error(`Provider already registered for capability: ${capability}`);
    this.#providers.set(capability, provider);
    return { capability, name: provider.name || 'unnamed' };
  }

  replace(capability, provider) {
    capability = requiredString(capability, 'capability');
    if (!provider || typeof provider.execute !== 'function') throw new TypeError('provider.execute(request, context) is required');
    this.#providers.set(capability, provider);
  }

  get(capability) { return this.#providers.get(capability); }
  list() { return [...this.#providers.entries()].map(([capability, provider]) => ({ capability, name: provider.name || 'unnamed' })); }
}

class PipelineRunner {
  constructor({ providerRegistry, ledger, artifactRegistry, maxAttempts = 2, timeoutMs = 120000, onEvent = () => {} }) {
    if (!providerRegistry || !ledger || !artifactRegistry) throw new TypeError('providerRegistry, ledger, and artifactRegistry are required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError('maxAttempts must be 1..5');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    this.providers = providerRegistry;
    this.ledger = ledger;
    this.artifacts = artifactRegistry;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
  }

  async runStage({ id, episodeId, stage, capability, providerRequest, inputVersionIds = [], idempotencyKey, createdBy = 'pipeline' }) {
    if (!PIPELINE_STAGES.includes(stage)) throw new Error(`Unknown pipeline stage: ${stage}`);
    const provider = this.providers.get(capability);
    if (!provider) throw new Error(`No provider configured for capability: ${capability}`);
    const logicalKey = requiredString(idempotencyKey, 'idempotencyKey');
    let run = this.ledger.start({
      id, episodeId, capability, provider: provider.name || 'unnamed',
      model: provider.model || null, inputVersionIds, idempotencyKey: logicalKey,
      request: providerRequest, attempt: 1,
    });
    if (run.status === 'SUCCEEDED') {
      return { run, artifacts: run.resultArtifactIds.map((id) => this.artifacts.get(id)).filter(Boolean), reused: true };
    }
    if (run.status !== 'QUEUED') throw new Error(`Idempotent run is already ${run.status}`);
    run = this.ledger.transition(run.id, 'RUNNING');
    this.onEvent({ type: 'provider-run.started', runId: run.id, episodeId, stage });

    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const output = await this.#withTimeout(
          provider.execute(immutableRecord(providerRequest), { runId: run.id, episodeId, stage, attempt, inputVersionIds }),
          this.timeoutMs,
        );
        if (!output || !Array.isArray(output.artifacts)) throw new TypeError('Provider must return { artifacts: [] }');
        const createdArtifacts = [];
        for (let index = 0; index < output.artifacts.length; index += 1) {
          const artifact = output.artifacts[index];
          const created = this.artifacts.register({
            ...artifact,
            id: artifact.id || `${run.id}-artifact-${index + 1}`,
            episodeId, versionId: artifact.versionId || `${run.id}-v${attempt}`,
            kind: artifact.kind || stage.toLowerCase().replaceAll('_', '-'),
            providerRunId: run.id, inputVersionIds, createdBy,
            source: artifact.source || provider.name || 'provider',
          });
          createdArtifacts.push(created);
        }
        const finalRun = this.ledger.transition(run.id, 'SUCCEEDED', {
          resultArtifactIds: createdArtifacts.map((a) => a.id),
          usage: output.usage || {},
          estimatedCost: output.estimatedCost ?? null,
          actualCost: output.actualCost ?? null,
          currency: output.currency || 'USD',
        });
        this.onEvent({ type: 'provider-run.succeeded', runId: run.id, episodeId, stage, artifactIds: finalRun.resultArtifactIds });
        return { run: finalRun, artifacts: createdArtifacts, reused: false };
      } catch (error) {
        lastError = error;
        const retryable = error && error.retryable === true;
        if (!retryable || attempt >= this.maxAttempts) break;
        this.onEvent({ type: 'provider-run.retrying', runId: run.id, episodeId, stage, attempt, reason: error.message });
      }
    }
    this.ledger.transition(run.id, 'FAILED', {
      error: { message: (lastError && lastError.message) || 'Provider failed', retryable: Boolean(lastError && lastError.retryable) },
    });
    this.onEvent({ type: 'provider-run.failed', runId: run.id, episodeId, stage });
    throw Object.assign(new Error(`Pipeline stage ${stage} failed: ${(lastError && lastError.message) || 'provider error'}`), {
      runId: run.id, cause: lastError,
    });
  }

  #withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`Provider timed out after ${timeoutMs}ms`), { retryable: true })), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

module.exports = { ProviderRegistry, PipelineRunner, PIPELINE_STAGES };
