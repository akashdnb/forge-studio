/**
 * Small immutable-record helper for Forge domain snapshots.
 */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  Object.freeze(value);
  return value;
}

function immutableRecord(value) {
  const cloned = cloneJson(value);
  return deepFreeze(cloned);
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
