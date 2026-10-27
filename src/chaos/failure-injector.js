class FailureInjector {
  constructor(rules = {}) { this.rules = rules; this.counts = new Map(); }
  static fromEnv(env = process.env) {
    const raw = env.FORGE_CHAOS_JSON;
    if (!raw) return new FailureInjector();
    let rules;
    try { rules = JSON.parse(raw); } catch (error) { throw new Error(`Invalid FORGE_CHAOS_JSON: ${error.message}`); }
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('FORGE_CHAOS_JSON must be an object');
    return new FailureInjector(rules);
  }
  async trip(point, context = {}) {
    const rule = this.rules[point];
    if (!rule) return;
    const count = (this.counts.get(point) || 0) + 1;
    this.counts.set(point, count);
    const after = Number.isInteger(rule.after) ? rule.after : 1;
    if (count < after || (rule.once && count > after)) return;
    if (Number.isInteger(rule.delayMs) && rule.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    const error = new Error(String(rule.message || `Synthetic failure at ${point}`));
    error.code = String(rule.code || 'SYNTHETIC_FAILURE');
    error.retryable = rule.retryable !== false;
    error.failurePoint = point;
    error.context = context;
    throw error;
  }
}
module.exports = { FailureInjector };
