/**
 * Small immutable-record helper for the Forge domain.
 * This core is intentionally dependency-free; persistence is an adapter.
 */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  // JSON cloning guarantees there are no shared object references or cycles.
  for (const child of Object.values(value)) deepFreeze(child);
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function immutableRecord(value) {
  return deepFreeze(cloneJson(value));
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function finiteNonNegative(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

module.exports = { cloneJson, deepFreeze, immutableRecord, requiredString, finiteNonNegative };
