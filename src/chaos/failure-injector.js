const crypto = require('node:crypto');

const TESTABLE_ENVS = new Set(['test', 'staging']);
const SCENARIO_POINTS = Object.freeze([
  'worker.before_execute',
  'worker.after_claim',
  'worker.before_heartbeat',
  'worker.before_succeed',
  'worker.before_fail',
  'scheduler.before_recover',
  'scheduler.after_claim',
  'callback.before_apply',
  'callback.after_apply',
  'provider.before_call',
  'artifact.before_upload',
  'artifact.after_upload',
  'db.before_transaction',
  'db.after_mutation',
]);

function hashSeed(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

function unit(seed, counter) {
  const digest = hashSeed(`${seed}:${counter}`);
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
}

function normalizeScenario(scenario = {}) {
  const rate = scenario.rate == null ? 1 : Number(scenario.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new TypeError('failure injection rate must be between 0 and 1');
  const points = scenario.points || (scenario.point ? [scenario.point] : []);
  if (!Array.isArray(points) || points.some((point) => !SCENARIO_POINTS.includes(point))) {
    throw new TypeError(`unsupported failure injection point; supported: ${SCENARIO_POINTS.join(', ')}`);
  }
  return { id: String(scenario.id || 'adhoc'), seed: String(scenario.seed || '0'), rate, points, mode: scenario.mode || 'throw', maxTrips: Number.isInteger(scenario.maxTrips) ? scenario.maxTrips : 1 };
}

class FailureInjector {
  constructor({ enabled = false, environment = process.env.NODE_ENV || 'development', seed = '0', scenarios = [], logger = console } = {}) {
    this.environment = environment;
    this.enabled = Boolean(enabled) && TESTABLE_ENVS.has(environment);
    this.seed = String(seed);
    this.logger = logger;
    this.scenarios = scenarios.map(normalizeScenario);
    this.counts = new Map();
  }

  static fromEnv(env = process.env, options = {}) {
    const enabled = env.FORGE_CHAOS_ENABLED === 'true';
    let scenarios = [];
    if (env.FORGE_CHAOS_SCENARIOS) {
      const parsed = JSON.parse(env.FORGE_CHAOS_SCENARIOS);
      if (!Array.isArray(parsed)) throw new TypeError('FORGE_CHAOS_SCENARIOS must be a JSON array');
      scenarios = parsed;
    }
    return new FailureInjector({ ...options, enabled, environment: env.NODE_ENV || 'development', seed: env.FORGE_CHAOS_SEED || '0', scenarios });
  }

  describe() {
    return { enabled: this.enabled, environment: this.environment, seed: this.seed, scenarios: this.scenarios.map((scenario) => ({ ...scenario })) };
  }

  shouldTrip(point, context = {}) {
    if (!this.enabled) return null;
    for (const scenario of this.scenarios) {
      if (!scenario.points.includes(point)) continue;
      const key = `${scenario.id}:${point}`;
      const count = this.counts.get(key) || 0;
      if (count >= scenario.maxTrips) continue;
      const draw = unit(`${this.seed}:${scenario.seed}:${context.jobId || ''}`, count);
      if (draw > scenario.rate) continue;
      this.counts.set(key, count + 1);
      return { ...scenario, point, trip: count + 1, draw };
    }
    return null;
  }

  async trip(point, context = {}) {
    const fault = this.shouldTrip(point, context);
    if (!fault) return null;
    this.logger.warn?.('[forge-chaos] injected fault', { point, scenario: fault.id, trip: fault.trip, seed: this.seed, jobId: context.jobId || null });
    if (fault.mode === 'return') return fault;
    const error = new Error(`Injected failure: ${fault.id} at ${point}`);
    error.code = `CHAOS_${fault.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    error.retryable = context.retryable !== false;
    error.chaos = { point, scenario: fault.id, seed: this.seed, trip: fault.trip };
    throw error;
  }
}

module.exports = { FailureInjector, SCENARIO_POINTS, TESTABLE_ENVS, normalizeScenario, unit };
