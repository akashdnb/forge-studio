require('./contract-governance').installApiContractGovernance();
const { createHash } = require('node:crypto');

const SUPPORTED_VERSIONS = Object.freeze(['1', '2']);
const DEFAULT_VERSION = '1';
const CURRENT_VERSION = '2';
const V1_SUNSET = process.env.FORGE_API_V1_SUNSET || '2027-04-27T00:00:00Z';
const JSON_LIMIT_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_PAGE_SIZE = 200;
const VERSION_MEDIA_TYPES = Object.freeze({ '1': 'application/vnd.forge.v1+json', '2': 'application/vnd.forge.v2+json' });
const VERSION_ALIASES = Object.freeze({ '/v2': '/v1' });
const ENUMS = Object.freeze({
  episodeState: new Set(['DRAFT', 'RESEARCHING', 'SCRIPTING', 'SCENE_PLANNING', 'NARRATING', 'TRANSCRIBING', 'ASSETS', 'TIMELINE', 'CAPTIONS', 'RENDERING', 'QA', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED']),
  approvalDecision: new Set(['APPROVED', 'REJECTED', 'REQUEST_CHANGES']),
  approvalStage: new Set(['SCRIPT', 'SCENE_PLAN', 'NARRATION', 'TIMELINE', 'FINAL_RENDER']),
});

function parseVersion(request) {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const pathMatch = /^\/v(\d+)(?:\/|$)/.exec(pathname);
  const mediaMatch = /application\/vnd\.forge\.v(\d+)\+json/i.exec(String(request.headers.accept || ''));
  if (!pathMatch && !mediaMatch) return null;
  const requested = pathMatch?.[1] || mediaMatch?.[1] || DEFAULT_VERSION;
  if (!SUPPORTED_VERSIONS.includes(requested)) throw Object.assign(new Error(`Unsupported API version: v${requested}`), { statusCode: 406, code: 'UNSUPPORTED_API_VERSION' });
  if (pathMatch && mediaMatch && pathMatch[1] !== mediaMatch[1]) throw Object.assign(new Error('URL API version and Accept API version must match'), { statusCode: 406, code: 'API_VERSION_MISMATCH' });
  return requested;
}

function normalizePath(request, version) {
  if (version !== '2') return;
  const parsed = new URL(request.url || '/', 'http://localhost');
  if (VERSION_ALIASES[parsed.pathname.split('/').slice(0, 2).join('/')]) {
    parsed.pathname = parsed.pathname.replace(/^\/v2(?=\/|$)/, '/v1');
    request.url = `${parsed.pathname}${parsed.search}`;
  }
}

function validateId(value, field = 'id') {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH || /[\u0000\r\n]/.test(value)) throw Object.assign(new Error(`${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`), { statusCode: 400, code: 'INVALID_ID' });
}

function validatePagination(url) {
  for (const name of ['limit', 'offset']) {
    if (!url.searchParams.has(name)) continue;
    const raw = url.searchParams.get(name);
    if (!/^\d+$/.test(raw)) throw Object.assign(new Error(`${name} must be a non-negative integer`), { statusCode: 400, code: 'INVALID_PAGINATION' });
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || (name === 'limit' && (value < 1 || value > MAX_PAGE_SIZE))) throw Object.assign(new Error(`${name} is outside the supported range`), { statusCode: 400, code: 'INVALID_PAGINATION' });
  }
}

function validateIdempotencyKey(request, body) {
  const key = request.headers['idempotency-key'] || body?.idempotencyKey;
  if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 255 || !/^[A-Za-z0-9._:-]+$/.test(key))) throw Object.assign(new Error('Idempotency-Key must be 8-255 characters using A-Z, a-z, 0-9, dot, underscore, colon or hyphen'), { statusCode: 400, code: 'INVALID_IDEMPOTENCY_KEY' });
}

function validateCommonBody(request, body, version) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('JSON body must be an object'), { statusCode: 400, code: 'INVALID_BODY' });
  for (const field of ['id', 'projectId', 'episodeId', 'versionId', 'artifactId', 'renderArtifactId', 'targetId', 'targetVersionId', 'packageId', 'runId']) validateId(body[field], field);
  validateIdempotencyKey(request, body);
  if (body.state !== undefined && !ENUMS.episodeState.has(body.state)) throw Object.assign(new Error(`Unsupported episode state: ${body.state}`), { statusCode: 400, code: 'INVALID_ENUM' });
  if (body.decision !== undefined && !ENUMS.approvalDecision.has(body.decision)) throw Object.assign(new Error(`Unsupported approval decision: ${body.decision}`), { statusCode: 400, code: 'INVALID_ENUM' });
  if (body.stage !== undefined && !ENUMS.approvalStage.has(body.stage)) throw Object.assign(new Error(`Unsupported approval stage: ${body.stage}`), { statusCode: 400, code: 'INVALID_ENUM' });
  if (body.status !== undefined && version === '2' && typeof body.status !== 'string') throw Object.assign(new Error('status must be a string enum value'), { statusCode: 400, code: 'INVALID_ENUM' });
}

function readBodyForValidation(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return null;
  if (!String(request.headers['content-type'] || '').toLowerCase().includes('application/json')) return null;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    request.on('data', (chunk) => { size += chunk.length; if (size > JSON_LIMIT_BYTES) reject(Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' })); else chunks.push(chunk); });
    request.on('end', () => { if (!size) return resolve({ body: {}, raw: Buffer.alloc(0) }); try { const raw = Buffer.concat(chunks); resolve({ body: JSON.parse(raw.toString('utf8')), raw }); } catch (cause) { reject(Object.assign(new Error('Malformed JSON request body'), { statusCode: 400, code: 'MALFORMED_JSON', cause })); } });
    request.on('error', reject);
  });
}

function replayBody(request, raw) {
  if (!raw) return;
  request[Symbol.asyncIterator] = async function* asyncIterator() { if (raw.length) yield raw; };
}

function versionHeaders(response, version, deprecated = false) {
  response.setHeader('x-api-version', `v${version}`);
  response.setHeader('vary', 'Accept');
  response.setHeader('x-api-compatibility', version === CURRENT_VERSION ? 'current' : 'legacy');
  response.setHeader('x-content-contract', `forge-api-v${version}`);
  if (deprecated) {
    response.setHeader('Deprecation', 'true');
    response.setHeader('Sunset', new Date(V1_SUNSET).toUTCString());
    response.setHeader('Link', '</docs/api-migration.md>; rel="deprecation"');
  }
}

function auditEvent(request, version, statusCode, logger = console) {
  const route = new URL(request.url || '/', 'http://localhost').pathname.replace(/^\/v2(?=\/|$)/, '/v1');
  logger.info?.(JSON.stringify({ event: 'api.version.request', apiVersion: `v${version}`, deprecated: version === '1', method: request.method, route, statusCode, requestId: request.headers['x-request-id'] || null }));
}

function createVersioningMiddleware({ logger = console, rateLimitPerMinute = Number(process.env.FORGE_API_VERSION_RATE_LIMIT_PER_MINUTE || 300) } = {}) {
  const buckets = new Map();
  const limit = Number.isSafeInteger(rateLimitPerMinute) && rateLimitPerMinute > 0 ? rateLimitPerMinute : 300;
  return async function versioningMiddleware(request, response, next) {
    let version = null;
    try {
      version = parseVersion(request);
      if (!version) return await next();
      const parsed = new URL(request.url || '/', 'http://localhost');
      validatePagination(parsed);
      const tokenFingerprint = createHash('sha256').update(String(request.headers.authorization || 'anonymous')).digest('hex').slice(0, 16);
      const key = `${version}:${tokenFingerprint}:${request.socket?.remoteAddress || 'unknown'}`;
      const now = Date.now();
      const bucket = buckets.get(key) || { count: 0, resetAt: now + 60_000 };
      if (now >= bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
      bucket.count += 1; buckets.set(key, bucket);
      response.setHeader('x-api-rate-limit', String(limit));
      response.setHeader('x-api-rate-remaining', String(Math.max(0, limit - bucket.count)));
      response.setHeader('x-api-rate-reset', String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count > limit) {
        versionHeaders(response, version, version === '1'); auditEvent(request, version, 429, logger);
        response.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ error: { code: 'API_VERSION_RATE_LIMITED', message: 'API version rate limit exceeded' }, requestId: request.headers['x-request-id'] || null }));
      }
      const body = await readBodyForValidation(request);
      if (body) { validateCommonBody(request, body.body, version); replayBody(request, body.raw); }
      request.headers['x-api-version'] = `v${version}`;
      request._forgeApiVersion = version;
      normalizePath(request, version);
      versionHeaders(response, version, version === '1');
      const originalEnd = response.end; let statusCode = 200; const originalWriteHead = response.writeHead;
      response.writeHead = function patchedWriteHead(status, ...args) { statusCode = status; versionHeaders(response, version, version === '1'); return originalWriteHead.call(this, status, ...args); };
      response.end = function patchedEnd(...args) { auditEvent(request, version, statusCode, logger); return originalEnd.apply(this, args); };
      await next();
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 400; const code = error.code || 'INVALID_REQUEST';
      if (version) auditEvent(request, version, status, logger);
      if (!response.headersSent) {
        if (version) versionHeaders(response, version, version === '1');
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { code, message: error.message }, requestId: request.headers['x-request-id'] || null }));
      }
    }
  };
}

function installHttpVersioning(options = {}) {
  const http = require('node:http');
  if (http.__forgeVersioningInstalled) return;
  const originalCreateServer = http.createServer;
  const middleware = createVersioningMiddleware(options);
  http.createServer = function patchedCreateServer(requestListener) {
    const server = originalCreateServer.call(this);
    const originalOn = server.on.bind(server); const originalAddListener = server.addListener.bind(server);
    const wrap = (listener) => listener ? (request, response) => middleware(request, response, () => listener(request, response)) : listener;
    server.on = (event, listener) => originalOn(event, event === 'request' ? wrap(listener) : listener);
    server.addListener = (event, listener) => originalAddListener(event, event === 'request' ? wrap(listener) : listener);
    if (requestListener) server.on('request', requestListener);
    return server;
  };
  http.__forgeVersioningInstalled = true;
}

function apiVersionContract() {
  return {
    policyVersion: 1, current: `v${CURRENT_VERSION}`, supported: SUPPORTED_VERSIONS.map((version) => `v${version}`), default: `v${DEFAULT_VERSION}`,
    sunset: { version: 'v1', date: V1_SUNSET, boundedCompatibilityWindowDays: Math.max(1, Math.ceil((new Date(V1_SUNSET) - Date.now()) / 86400000)) },
    rules: { breakingChanges: 'new-major-version-only', additiveChanges: 'allowed-within-a-version', unknownResponseFields: 'clients-must-ignore', unknownRequestFields: 'accepted-v1-and-ignored; rejected-only-when-schema-marks-strict', durableSemantics: 'version-adapters-must-not-change-job-artifact-workflow-approval-budget-or-security-identity', ids: `non-empty strings <= ${MAX_ID_LENGTH} characters`, pagination: `limit 1-${MAX_PAGE_SIZE}; offset non-negative integer`, errors: 'stable {error:{code,message},requestId}', idempotency: 'Idempotency-Key or idempotencyKey is validated and preserved' },
    mediaTypes: VERSION_MEDIA_TYPES,
  };
}

module.exports = { SUPPORTED_VERSIONS, CURRENT_VERSION, V1_SUNSET, VERSION_MEDIA_TYPES, parseVersion, validateId, validatePagination, validateCommonBody, createVersioningMiddleware, installHttpVersioning, apiVersionContract };
