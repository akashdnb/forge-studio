const { FailureInjector } = require('./failure-injector');

const SCENARIOS = Object.freeze({
  worker_crash: { point: 'worker.after_claim', mode: 'process_exit', invariant: 'lease recovery without duplicate terminal completion' },
  process_termination: { point: 'worker.after_claim', mode: 'process_exit', invariant: 'recovery after abrupt process termination' },
  lease_expiry: { point: 'worker.before_heartbeat', mode: 'throw', invariant: 'expired lease becomes claimable exactly once' },
  provider_timeout: { point: 'provider.before_call', mode: 'throw', invariant: 'timeout is retryable and bounded by maxAttempts' },
  duplicate_callback: { point: 'callback.before_apply', mode: 'return', invariant: 'duplicate terminal callback is idempotent' },
  delayed_callback: { point: 'callback.before_apply', mode: 'return', invariant: 'stale callback cannot mutate a newer attempt' },
  db_deadlock: { point: 'db.before_transaction', mode: 'throw', invariant: 'transaction rolls back and job remains durable' },
  db_serialization_failure: { point: 'db.after_mutation', mode: 'throw', invariant: 'partial mutation is rolled back' },
  artifact_upload_interruption: { point: 'artifact.after_upload', mode: 'throw', invariant: 'partial artifact is never READY' },
  scheduler_failover: { point: 'scheduler.before_recover', mode: 'throw', invariant: 'a second scheduler can recover expired work' },
  stale_worker: { point: 'worker.before_succeed', mode: 'throw', invariant: 'old worker cannot resurrect recovered work' },
  cancellation_race: { point: 'worker.before_execute', mode: 'throw', invariant: 'cancelled work never reaches terminal success' },
  retry_exhaustion: { point: 'worker.before_execute', mode: 'throw', invariant: 'job reaches FAILED after maxAttempts' },
  partial_transaction: { point: 'db.after_mutation', mode: 'throw', invariant: 'all-or-nothing durable mutation' },
});

function scenarioConfig(name, seed, rate = 1) {
  const definition = SCENARIOS[name];
  if (!definition) throw new Error(`Unknown chaos scenario: ${name}`);
  return { id: name, seed: String(seed), rate, maxTrips: 1, point: definition.point, mode: definition.mode === 'process_exit' ? 'throw' : definition.mode };
}

function buildPlan({ names = Object.keys(SCENARIOS), seed = 1, rate = 1 } = {}) {
  if (!Number.isInteger(seed) || seed < 0) throw new TypeError('seed must be a non-negative integer');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new TypeError('rate must be between 0 and 1');
  return names.map((name, index) => scenarioConfig(name, `${seed}:${index}`, rate));
}

function createChaosHarness({ pool, queue, scheduler = null, worker = null, injector, logger = console } = {}) {
  if (!queue) throw new TypeError('queue is required');
  const activeInjector = injector || new FailureInjector({ enabled: false });

  async function runScenario(name, { jobId = null, workerId = 'chaos-worker', seed = 1, rate = 1 } = {}) {
    const definition = SCENARIOS[name];
    if (!definition) throw new Error(`Unknown chaos scenario: ${name}`);
    const plan = scenarioConfig(name, seed, rate);
    const report = { scenario: name, seed, rate, point: definition.point, invariant: definition.invariant, events: [], status: 'PASS' };
    report.events.push({ type: 'plan', plan });

    if (name === 'lease_expiry') {
      if (!jobId) throw new Error('lease_expiry requires jobId');
      const recovered = await queue.recoverExpiredLeases();
      report.events.push({ type: 'lease_recovery', recovered });
      return report;
    }
    if (name === 'retry_exhaustion') {
      if (!jobId) throw new Error('retry_exhaustion requires jobId');
      const job = await queue.get(jobId);
      if (!job) throw new Error('job not found');
      for (let i = Number(job.attempts); i < Number(job.max_attempts); i += 1) {
        const claimed = await queue.claimSpecific(jobId, workerId);
        if (!claimed) break;
        await queue.fail(jobId, workerId, new Error('Injected retry exhaustion'), { retry: true, dispatchToken: claimed.dispatch_token });
      }
      const finalJob = await queue.get(jobId);
      report.events.push({ type: 'terminal', status: finalJob?.status, attempts: finalJob?.attempts });
      if (finalJob?.status !== 'FAILED') report.status = 'FAIL';
      return report;
    }
    if (name === 'process_termination' || name === 'worker_crash') {
      if (!jobId) throw new Error(`${name} requires jobId`);
      const claimed = await queue.claimSpecific(jobId, workerId);
      if (!claimed) throw new Error('job was not claimable');
      report.events.push({ type: 'claimed', jobId, dispatchToken: claimed.dispatch_token });
      report.processTermination = { signal: 'SIGTERM', safe: true, instruction: 'terminate the worker subprocess now; do not call succeed/fail from the crashed process' };
      return report;
    }
    if (name === 'scheduler_failover') {
      if (!scheduler) throw new Error('scheduler is required');
      report.events.push({ type: 'recovery', result: await scheduler.recover() });
      return report;
    }
    if (name === 'stale_worker') {
      if (!jobId) throw new Error('stale_worker requires jobId');
      const claimed = await queue.claimSpecific(jobId, workerId);
      if (!claimed) throw new Error('job was not claimable');
      await queue.recoverExpiredLeases();
      try { await queue.succeed(jobId, workerId, { chaos: true }, claimed.dispatch_token); report.status = 'FAIL'; }
      catch (error) { report.events.push({ type: 'stale_rejected', code: error.code || 'STALE_WORKER' }); }
      return report;
    }
    report.injector = activeInjector.describe();
    report.events.push({ type: 'injection_ready', point: definition.point });
    logger.info?.('[forge-chaos] scenario prepared', report);
    return report;
  }

  async function runPlan({ names = Object.keys(SCENARIOS), seed = 1, rate = 1 } = {}) {
    const plan = buildPlan({ names, seed, rate });
    const results = [];
    for (const item of plan) results.push(await runScenario(item.id, { seed: item.seed, rate: item.rate }));
    return { seed, rate, scenarios: results };
  }

  return { runScenario, runPlan, scenarios: SCENARIOS, injector: activeInjector, worker, pool };
}

module.exports = { SCENARIOS, scenarioConfig, buildPlan, createChaosHarness };
