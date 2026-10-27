'use strict';
const http = require('node:http');
const { Pool } = require('pg');
const { authenticate, hasRole, applySecurityHeaders } = require('../security/http-security');
const { validateRuntimeConfig, SecretCipher, RuntimePolicyStore } = require('./runtime-policy');
const { EncryptedSecretStore } = require('./secret-store');
const validation = validateRuntimeConfig(process.env, { requirePersistence: process.env.NODE_ENV === 'production' });
if (!validation.ok) throw Object.assign(new Error(`Runtime configuration invalid: ${JSON.stringify(validation.issues)}`), { code: 'INVALID_RUNTIME_CONFIG' });
const enabled = process.env.FORGE_RUNTIME_POLICY_ENABLED === 'true';
let store = null; let secrets = null; let pool = null;
if (enabled && process.env.DATABASE_URL) { pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Math.min(5, Number.parseInt(process.env.PG_POOL_MAX || '10', 10)) }); const cipher = process.env.FORGE_SECRET_ENCRYPTION_KEY ? new SecretCipher(process.env.FORGE_SECRET_ENCRYPTION_KEY) : null; store = new RuntimePolicyStore({ pool, secretCipher: cipher }); if (cipher) secrets = new EncryptedSecretStore({ pool, cipher }); }
function json(res, status, body) { applySecurityHeaders(res); res.setHeader('content-type', 'application/json; charset=utf-8'); res.writeHead(status); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.setEncoding('utf8'); req.on('data', c => { raw += c; if (raw.length > 1024 * 1024) reject(Object.assign(new Error('request too large'), { statusCode: 413 })); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 })); } }); req.on('error', reject); }); }
async function metrics(res) {
  const [policies, flags, secretsCount, snapshots] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM runtime_policy_versions WHERE state='ACTIVE'"),
    pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE kill_switch)::int AS kills FROM runtime_feature_flags'),
    pool.query("SELECT count(*)::int AS n FROM runtime_secrets WHERE status='ACTIVE'"),
    pool.query('SELECT count(*)::int AS n FROM forge_jobs WHERE runtime_snapshot IS NOT NULL AND status IN (\'QUEUED\',\'RUNNING\')')
  ]);
  res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.writeHead(200);
  res.end([`forge_runtime_active_policies ${policies.rows[0].n}`, `forge_runtime_feature_flags ${flags.rows[0].n}`, `forge_runtime_feature_kill_switches ${flags.rows[0].kills}`, `forge_runtime_active_secrets ${secretsCount.rows[0].n}`, `forge_runtime_snapshotted_inflight_jobs ${snapshots.rows[0].n}`].join('\n') + '\n');
}
async function handle(req, res) {
  if (!enabled || !store) return false;
  const url = new URL(req.url || '/', 'http://localhost'); if (!url.pathname.startsWith('/internal/runtime/')) return false;
  const auth = authenticate(req, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
  if (!auth || !hasRole(auth, 'OWNER')) return json(res, 403, { error: { code: 'FORBIDDEN' } });
  try {
    if (url.pathname === '/internal/runtime/readiness' && req.method === 'GET') { const result = await store.readiness({ requireEncryption: process.env.FORGE_REQUIRE_SECRET_ENCRYPTION === 'true' }); return json(res, result.ok ? 200 : 503, result); }
    if (url.pathname === '/internal/runtime/diagnostics' && req.method === 'GET') return json(res, 200, await store.diagnostics({ tenantId: auth.tenantId }));
    if (url.pathname === '/internal/runtime/metrics' && req.method === 'GET') return metrics(res);
    if (url.pathname === '/internal/runtime/policies' && req.method === 'POST') { const input = await body(req); if (input.projectId) { const project = (await pool.query('SELECT tenant_id FROM projects WHERE id=$1', [input.projectId])).rows[0]; if (!project || project.tenant_id !== auth.tenantId) return json(res, 403, { error: { code: 'TENANT_ISOLATION' } }); } if (input.tenantId && input.tenantId !== auth.tenantId) return json(res, 403, { error: { code: 'TENANT_ISOLATION' } }); const provider = input.provider ? `${auth.tenantId}:${input.provider}` : null; return json(res, 201, await store.publishPolicy({ ...input, tenantId: auth.tenantId, provider, actor: auth.actor })); }
    const rollback = /^\/internal\/runtime\/policies\/([^/]+)\/([^/]+)\/([^/]+)\/rollback$/.exec(url.pathname); if (rollback && req.method === 'POST') { const input = await body(req); let scopeId = decodeURIComponent(rollback[2]); if (decodeURIComponent(rollback[1]) === 'PROVIDER') scopeId = `${auth.tenantId}:${scopeId}`; return json(res, 200, await store.rollbackPolicy({ scopeType: decodeURIComponent(rollback[1]), scopeId, namespace: decodeURIComponent(rollback[3]), targetVersion: input.targetVersion, actor: auth.actor, tenantId: auth.tenantId, projectId: input.projectId })); }
    if (url.pathname === '/internal/runtime/flags' && req.method === 'POST') return json(res, 200, await store.setFlag({ ...(await body(req)), actor: auth.actor }));
    if (url.pathname === '/internal/runtime/secrets' && req.method === 'POST') { const input = await body(req); if (!secrets) throw Object.assign(new Error('secret encryption is not configured'), { code: 'SECRET_ENCRYPTION_UNAVAILABLE', statusCode: 503 }); if (input.tenantId && input.tenantId !== auth.tenantId) return json(res, 403, { error: { code: 'TENANT_ISOLATION' } }); return json(res, 200, await secrets.put({ ...input, tenantId: auth.tenantId, actor: auth.actor })); }
    if (url.pathname === '/internal/runtime/secrets/retire' && req.method === 'POST') { const input = await body(req); if (!secrets) throw Object.assign(new Error('secret encryption is not configured'), { code: 'SECRET_ENCRYPTION_UNAVAILABLE', statusCode: 503 }); return json(res, 200, await secrets.retire({ ...input, tenantId: auth.tenantId, actor: auth.actor })); }
    return json(res, 404, { error: { code: 'NOT_FOUND' } });
  } catch (error) { return json(res, error.statusCode || 500, { error: { code: error.code || 'RUNTIME_POLICY_ERROR', message: error.statusCode === 409 ? error.message : 'Request could not be completed' } }); }
}
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function forgeRuntimeEmit(event, ...args) { if (event === 'request' && args[0]?.url?.startsWith('/internal/runtime/')) { handle(args[0], args[1]).catch(error => json(args[1], 500, { error: { code: error.code || 'RUNTIME_POLICY_ERROR' } })); return true; } return originalEmit.call(this, event, ...args); };
module.exports = { validation, store, secrets };
