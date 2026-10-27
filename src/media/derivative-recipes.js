const crypto = require('node:crypto');

const RECIPE_VERSION = 'media-derivatives-v1';
const MAX_PREVIEW_SECONDS = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_PREVIEW_SECONDS || '30', 10);
const MAX_CONTACT_SHEETS = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_CONTACT_SHEETS || '12', 10);
const MAX_PROXY_SECONDS = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_PROXY_SECONDS || '900', 10);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRecipe(input) {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('Derivative recipe is required'), { code: 'INVALID_RECIPE', retryable: false });
  const type = String(input.type || '').toLowerCase();
  const common = { recipeVersion: RECIPE_VERSION, type };
  if (type === 'poster') {
    const timestamp = Number(input.timestampSeconds || 0);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw Object.assign(new Error('Poster timestamp must be non-negative'), { code: 'INVALID_RECIPE', retryable: false });
    return Object.freeze({ ...common, timestampSeconds: Number(timestamp.toFixed(3)), width: 640, height: 360, format: 'jpeg', quality: 82 });
  }
  if (type === 'contact-sheet') {
    const count = Number(input.count || 9);
    if (!Number.isInteger(count) || count < 1 || count > MAX_CONTACT_SHEETS) throw Object.assign(new Error(`Contact sheet count must be 1..${MAX_CONTACT_SHEETS}`), { code: 'INVALID_RECIPE', retryable: false });
    return Object.freeze({ ...common, count, columns: Math.min(4, count), width: 320, height: 180, format: 'jpeg', quality: 78 });
  }
  if (type === 'waveform') {
    const width = Number(input.width || 1200);
    if (!Number.isInteger(width) || width < 320 || width > 2000) throw Object.assign(new Error('Waveform width is out of bounds'), { code: 'INVALID_RECIPE', retryable: false });
    return Object.freeze({ ...common, width, height: 300, format: 'png', colors: 'white' });
  }
  if (type === 'proxy') {
    const maxDuration = Number(input.maxDurationSeconds || MAX_PROXY_SECONDS);
    if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > MAX_PROXY_SECONDS) throw Object.assign(new Error(`Proxy duration exceeds ${MAX_PROXY_SECONDS}s limit`), { code: 'INVALID_RECIPE', retryable: false });
    return Object.freeze({ ...common, maxDurationSeconds: Number(maxDuration.toFixed(3)), width: 640, height: 360, videoCodec: 'libx264', audioCodec: 'aac', crf: 30, preset: 'veryfast', format: 'mp4' });
  }
  if (type === 'clip') {
    const start = Number(input.startSeconds || 0);
    const duration = Number(input.durationSeconds || 5);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > MAX_PREVIEW_SECONDS) throw Object.assign(new Error(`Preview clip must be <= ${MAX_PREVIEW_SECONDS}s`), { code: 'INVALID_RECIPE', retryable: false });
    return Object.freeze({ ...common, startSeconds: Number(start.toFixed(3)), durationSeconds: Number(duration.toFixed(3)), width: 640, height: 360, videoCodec: 'libx264', audioCodec: 'aac', crf: 29, preset: 'veryfast', format: 'mp4' });
  }
  throw Object.assign(new Error(`Unsupported derivative recipe: ${type}`), { code: 'INVALID_RECIPE', retryable: false });
}

function derivativeIdentity({ sourceChecksum, recipe }) {
  if (!/^[a-f0-9]{64}$/i.test(String(sourceChecksum || ''))) throw new TypeError('A SHA-256 source checksum is required');
  const normalized = normalizeRecipe(recipe);
  const recipeHash = sha256(stableJson(normalized));
  const identity = sha256(`forge-derivative\0${sourceChecksum.toLowerCase()}\0${recipeHash}`);
  return { identity, recipeHash, recipe: normalized };
}

function derivativeArtifactId({ sourceChecksum, recipe }) {
  const { identity } = derivativeIdentity({ sourceChecksum, recipe });
  return `derivative:${identity}`;
}

module.exports = { RECIPE_VERSION, MAX_PREVIEW_SECONDS, MAX_CONTACT_SHEETS, MAX_PROXY_SECONDS, stableJson, sha256, normalizeRecipe, derivativeIdentity, derivativeArtifactId };
