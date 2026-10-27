'use strict';
const { ProviderCircuitBreaker: Base } = require('./provider-circuit-breaker-runtime');
function normalize(context = {}) { return { ...context, service: context.service || context.capability || '' }; }
class ProviderCircuitBreaker extends Base {
  async allow(context, candidate) { return super.allow(normalize(context), candidate); }
  async outcome(context, result) { return super.outcome(normalize(context), result); }
  async inspect(context) { return super.inspect(normalize(context)); }
  async setManual(context, action, options) { return super.setManual(normalize(context), action, options); }
  async history(context, limit) { return super.history(normalize(context), limit); }
  async diagnostics(context) { return super.diagnostics(normalize(context)); }
}
module.exports = { ProviderCircuitBreaker };
