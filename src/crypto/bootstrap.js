'use strict';
const http = require('node:http');
const { Pool } = require('pg');
const { SecretCipher, RuntimePolicyStore } = require('../runtime/runtime-policy');
const { ProviderCredentialRegistry } = require('../providers/credential-registry');
const { authenticate, hasRole, safeError } = require('../security/http-security');
const { KeyManagementService, fail } = require('./key-management');
const { ReencryptionJobService } = require('./reencryption-worker');

const installed = Symbol.for('forge.crypto.kms.installed');
const metrics = { counts: new Map(), inc(name, labels = {}) { const key = `${name}:${JSON.stringify(labels)}`; this.counts.set(key, (this.counts.get(key) || 0) + 1); }, snapshot() { return [...this.counts.entries()].map(([key, value]) => ({ key, value })); } };
function json(res, status, body) { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(request) { let raw = ''; for await (const chunk of request) raw += chunk; if (!raw) return {}; try { return JSON.parse(raw); } catch { throw fail('invalid JSON', 'INVALID_JSON', 400); } }
function operatorAuth(request) { return authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null }); }

if (!http.Server.prototype[installed] && process.env.DATABASE_URL) {
  if (!process.env.FORGE_SECRET_ENCRYPTION_KEY) throw new Error('FORGE_SECRET_ENCRYPTION_KEY is required when cryptographic persistence is enabled');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_CRYPTO_POOL_MAX || '3', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  const kms = new KeyManagementService({ pool, rootKey: process.env.FORGE_SECRET_ENCRYPTION_KEY, metrics });
  const reencrypt = new ReencryptionJobService({ pool, kms, workerId: process.env.FORGE_CRYPTO_WORKER_ID });

  const legacyEncrypt = SecretCipher.prototype.encrypt;
  const legacyDecrypt = SecretCipher.prototype.decrypt;
  SecretCipher.prototype.encrypt = function scopedEncrypt(plaintext) {
    const context = KeyManagementService.context();
    if (!context?.tenantId) return legacyEncrypt.call(this, plaintext);
    return kms.encrypt({ tenantId: context.tenantId, projectId: context.projectId, purpose: context.purpose || 'runtime-secret', plaintext });
  };
  SecretCipher.prototype.decrypt = function scopedDecrypt(record) {
    const context = KeyManagementService.context();
    if (!context?.tenantId || !record || (record.epoch === undefined && record.key_epoch === undefined)) return legacyDecrypt.call(this, record);
    return kms.decrypt({ ...record, epoch: Number(record.epoch ?? record.key_epoch), tenantId: context.tenantId, projectId: context.projectId, purpose: context.purpose || 'runtime-secret' });
  };

  async function bindPersistedEpoch(table, id, context) {
    const row = (await pool.query(`SELECT ciphertext,nonce,auth_tag FROM ${table} WHERE id=$1 AND tenant_id=$2 AND project_id IS NOT DISTINCT FROM $3`, [id, context.tenantId, context.projectId])).rows[0];
    if (!row) return null;
    const epochs = (await pool.query(`SELECT epoch FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND status<>'REVOKED' ORDER BY epoch DESC`, [context.tenantId, context.projectId, context.purpose])).rows;
    for (const candidate of epochs) {
      try {
        await kms.decrypt({ ...row, epoch: Number(candidate.epoch), tenantId: context.tenantId, projectId: context.projectId, purpose: context.purpose });
        await pool.query(`UPDATE ${table} SET key_id=$1,key_epoch=$2 WHERE id=$3 AND tenant_id=$4 AND project_id IS NOT DISTINCT FROM $5`, [`forge-kms-${context.purpose}-v${candidate.epoch}`, candidate.epoch, id, context.tenantId, context.projectId]);
        return Number(candidate.epoch);
      } catch {}
    }
    throw fail('new ciphertext could not be bound to a tenant key epoch', 'KEY_EPOCH_BIND_FAILED', 503);
  }

  const wrapRegistry = (name, purpose) => {
    const original = ProviderCredentialRegistry.prototype[name];
    if (typeof original !== 'function' || original.__forgeKmsWrapped) return;
    const wrapped = async function cryptoScopedCredentialMethod(args = {}) {
      const context = { tenantId: args.tenantId, projectId: args.projectId || null, purpose };
      if (!context.tenantId) throw fail('tenant scope required', 'TENANT_SCOPE_REQUIRED', 403);
      const result = await KeyManagementService.withContext(context, () => original.call(this, args));
      if (name === 'create' || name === 'rotate') {
        const credentialId = result?.id || result?.credential_id;
        if (credentialId) await bindPersistedEpoch('forge_provider_credentials', credentialId, context);
      }
      return result;
    };
    wrapped.__forgeKmsWrapped = true;
    ProviderCredentialRegistry.prototype[name] = wrapped;
  };
  for (const name of ['create', 'rotate', 'selectAndLease']) wrapRegistry(name, 'provider-credential');

  const wrapRuntime = (name, purpose) => {
    const original = RuntimePolicyStore.prototype[name];
    if (typeof original !== 'function' || original.__forgeKmsWrapped) return;
    const wrapped = async function cryptoScopedRuntimeMethod(args = {}) {
      const context = { tenantId: args.tenantId, projectId: args.projectId || null, purpose };
      if (!context.tenantId) throw fail('tenant scope required', 'TENANT_SCOPE_REQUIRED', 403);
      const result = await KeyManagementService.withContext(context, () => original.call(this, args));
      if (name === 'putSecret') {
        const row = (await pool.query(`SELECT id FROM runtime_secrets WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider IS NOT DISTINCT FROM $3 AND name=$4`, [context.tenantId, context.projectId, args.provider || null, args.name])).rows[0];
        if (row) await bindPersistedEpoch('runtime_secrets', row.id, context);
      }
      return result;
    };
    wrapped.__forgeKmsWrapped = true;
    RuntimePolicyStore.prototype[name] = wrapped;
  };
  wrapRuntime('putSecret', 'runtime-secret');
  wrapRuntime('resolveSecret', 'runtime-secret');

  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function cryptoControlPlaneOn(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this, event, listener);
    const wrapped = async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/internal/crypto')) return listener(request, response);
      const auth = operatorAuth(request);
      const requestId = request.headers['x-request-id'] || require('node:crypto').randomUUID();
      if (!auth) return safeError(response, 401, 'UNAUTHORIZED', requestId);
      if (!hasRole(auth, 'OWNER')) return safeError(response, 403, 'FORBIDDEN', requestId);
      try {
        const url = new URL(request.url || '/', 'http://localhost');
        if (request.method === 'GET' && pathname === '/internal/crypto/keys') return json(response, 200, { data: await kms.list({ tenantId: auth.tenantId, projectId: url.searchParams.get('projectId') || null, purpose: url.searchParams.get('purpose') || null }) });
        if (request.method === 'GET' && pathname === '/internal/crypto/health') return json(response, 200, { data: await kms.health({ tenantId: auth.tenantId }) });
        if (request.method === 'GET' && pathname === '/internal/crypto/metrics') return json(response, 200, { data: metrics.snapshot() });
        if (request.method === 'POST' && pathname === '/internal/crypto/rotate') {
          const input = await body(request); if (!input.purpose) throw fail('purpose is required', 'INVALID_REQUEST', 400);
          return json(response, 200, { data: await kms.rotate({ tenantId: auth.tenantId, projectId: input.projectId || null, purpose: input.purpose, actor: auth.actor, reason: input.reason || 'operator rotation', expectedEpoch: input.expectedEpoch ?? null }) });
        }
        if (request.method === 'POST' && pathname === '/internal/crypto/revoke') {
          const input = await body(request); if (!input.purpose || !Number.isInteger(Number(input.epoch))) throw fail('purpose and epoch are required', 'INVALID_REQUEST', 400);
          return json(response, 200, { data: await kms.revoke({ tenantId: auth.tenantId, projectId: input.projectId || null, purpose: input.purpose, epoch: Number(input.epoch), actor: auth.actor, reason: input.reason || 'operator revocation' }) });
        }
        if (request.method === 'POST' && pathname === '/internal/crypto/reencryption/jobs') {
          const input = await body(request); return json(response, 202, { data: await reencrypt.enqueue({ ...input, tenantId: auth.tenantId, actor: auth.actor }) });
        }
        return json(response, 404, { error: { code: 'NOT_FOUND' } });
      } catch (error) { metrics.inc('forge_crypto_operator_errors_total', { code: error.code || 'ERROR' }); return json(response, error.statusCode || 500, { error: { code: error.code || 'CRYPTO_OPERATION_FAILED' }, requestId }); }
    };
    return originalOn.call(this, event, wrapped);
  };

  http.Server.prototype[installed] = { pool, kms, reencrypt, metrics };
}

module.exports = { installed, metrics };
