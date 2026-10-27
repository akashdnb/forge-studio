'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const KEY_PURPOSES = new Set(['provider-credential','runtime-secret','webhook-secret','capability-token','export-secret','audit-sensitive','artifact-content','runner-secret']);
const contexts = new AsyncLocalStorage();

function fail(message, code = 'KEY_MANAGEMENT_ERROR', statusCode = 503) {
  return Object.assign(new Error(message), { code, statusCode });
}
function normalizeRootKey(input) {
  const raw = String(input || '');
  try { const decoded = Buffer.from(raw, 'base64'); if (decoded.length === 32) return decoded; } catch {}
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length !== 32) throw new TypeError('FORGE_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key or exactly 32 UTF-8 bytes');
  return bytes;
}
function aadFor({ tenantId, projectId, purpose, epoch }) {
  return Buffer.from(`forge-kms:v1|tenant=${tenantId}|project=${projectId || '*'}|purpose=${purpose}|epoch=${epoch}`, 'utf8');
}
function wrapKey(root, key, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', root, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
function unwrapKey(root, row, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', root, Buffer.from(row.wrap_nonce));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(row.wrap_auth_tag));
  return Buffer.concat([decipher.update(Buffer.from(row.wrapped_key)), decipher.final()]);
}

class KeyManagementService {
  constructor({ pool, rootKey, metrics = null } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    this.pool = pool;
    this.rootKey = normalizeRootKey(rootKey);
    this.metrics = metrics || { inc() {} };
  }

  static withContext(context, fn) {
    if (!context?.tenantId) throw fail('tenant scope is required', 'TENANT_SCOPE_REQUIRED', 403);
    return contexts.run({ ...context }, fn);
  }
  static context() { return contexts.getStore() || null; }

  #scope(scope) {
    if (!scope?.tenantId) throw fail('tenant scope is required', 'TENANT_SCOPE_REQUIRED', 403);
    if (!KEY_PURPOSES.has(scope.purpose)) throw fail('unsupported key purpose', 'KEY_PURPOSE_INVALID', 400);
    return { tenantId: String(scope.tenantId), projectId: scope.projectId ? String(scope.projectId) : null, purpose: scope.purpose };
  }

  async ensureEpoch({ tenantId, projectId = null, purpose, actor = 'system' }) {
    const scope = this.#scope({ tenantId, projectId, purpose });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kms:${scope.tenantId}:${scope.projectId || '*'}:${scope.purpose}`]);
      let row = (await client.query(`SELECT * FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND status='ACTIVE' ORDER BY epoch DESC LIMIT 1 FOR UPDATE`, [scope.tenantId, scope.projectId, scope.purpose])).rows[0];
      if (!row) {
        const epoch = 1;
        const key = crypto.randomBytes(32);
        const wrapped = wrapKey(this.rootKey, key, aadFor({ ...scope, epoch }));
        row = (await client.query(`INSERT INTO forge_crypto_key_epochs(tenant_id,project_id,purpose,epoch,status,wrapped_key,wrap_nonce,wrap_auth_tag,key_fingerprint,created_by,activated_at) VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,now()) RETURNING *`, [scope.tenantId, scope.projectId, scope.purpose, epoch, wrapped.ciphertext, wrapped.nonce, wrapped.authTag, crypto.createHash('sha256').update(key).digest('hex'), actor])).rows[0];
        key.fill(0);
        await client.query(`INSERT INTO forge_crypto_key_audit(tenant_id,project_id,purpose,epoch,action,actor,details) VALUES($1,$2,$3,$4,'CREATE',$5,'{}'::jsonb)`, [scope.tenantId, scope.projectId, scope.purpose, epoch, actor]);
      }
      await client.query('COMMIT');
      return row;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async rotate({ tenantId, projectId = null, purpose, actor = 'system', reason = 'operator rotation', expectedEpoch = null }) {
    const scope = this.#scope({ tenantId, projectId, purpose });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kms:${scope.tenantId}:${scope.projectId || '*'}:${scope.purpose}`]);
      const current = (await client.query(`SELECT * FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND status='ACTIVE' ORDER BY epoch DESC LIMIT 1 FOR UPDATE`, [scope.tenantId, scope.projectId, scope.purpose])).rows[0];
      const currentEpoch = Number(current?.epoch || 0);
      if (expectedEpoch !== null && currentEpoch !== Number(expectedEpoch)) throw fail('stale key epoch', 'STALE_KEY_EPOCH', 409);
      const epoch = currentEpoch + 1;
      const key = crypto.randomBytes(32);
      const wrapped = wrapKey(this.rootKey, key, aadFor({ ...scope, epoch }));
      if (current) await client.query(`UPDATE forge_crypto_key_epochs SET status='RETIRING',retirement_requested_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'`, [current.id]);
      const row = (await client.query(`INSERT INTO forge_crypto_key_epochs(tenant_id,project_id,purpose,epoch,status,wrapped_key,wrap_nonce,wrap_auth_tag,key_fingerprint,created_by,activated_at,rotation_reason) VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,now(),$10) RETURNING tenant_id,project_id,purpose,epoch,status,key_fingerprint,created_by,activated_at`, [scope.tenantId, scope.projectId, scope.purpose, epoch, wrapped.ciphertext, wrapped.nonce, wrapped.authTag, crypto.createHash('sha256').update(key).digest('hex'), actor, reason])).rows[0];
      await client.query(`INSERT INTO forge_crypto_key_audit(tenant_id,project_id,purpose,epoch,action,actor,details) VALUES($1,$2,$3,$4,'ROTATE',$5,$6::jsonb)`, [scope.tenantId, scope.projectId, scope.purpose, epoch, actor, JSON.stringify({ reason, previousEpoch: currentEpoch })]);
      await client.query('COMMIT');
      key.fill(0);
      return row;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async revoke({ tenantId, projectId = null, purpose, epoch, actor = 'system', reason = 'operator revocation' }) {
    const scope = this.#scope({ tenantId, projectId, purpose });
    const result = await this.pool.query(`UPDATE forge_crypto_key_epochs SET status='REVOKED',revoked_at=now(),revocation_reason=$5,updated_at=now() WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND epoch=$4 AND status<>'REVOKED' RETURNING epoch,status`, [scope.tenantId, scope.projectId, scope.purpose, epoch, reason]);
    if (!result.rows[0]) throw fail('key epoch not found', 'KEY_EPOCH_NOT_FOUND', 404);
    await this.pool.query(`INSERT INTO forge_crypto_key_audit(tenant_id,project_id,purpose,epoch,action,actor,details) VALUES($1,$2,$3,$4,'REVOKE',$5,$6::jsonb)`, [scope.tenantId, scope.projectId, scope.purpose, epoch, actor, JSON.stringify({ reason })]);
    return result.rows[0];
  }

  async #keyFor(scope, epoch = null) {
    const normalized = this.#scope(scope);
    const row = (await this.pool.query(`SELECT * FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND epoch=COALESCE($4,(SELECT max(epoch) FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND purpose=$3 AND status='ACTIVE'))`, [normalized.tenantId, normalized.projectId, normalized.purpose, epoch])).rows[0];
    if (!row) throw fail('cryptographic key epoch unavailable', 'KEY_EPOCH_UNAVAILABLE', 503);
    if (row.status === 'REVOKED') throw fail('cryptographic key epoch revoked', 'KEY_EPOCH_REVOKED', 503);
    return { row, key: unwrapKey(this.rootKey, row, aadFor({ ...normalized, epoch: row.epoch })) };
  }

  async encrypt({ tenantId, projectId = null, purpose, plaintext, actor = 'system', epoch = null }) {
    if (plaintext === undefined || plaintext === null) throw new TypeError('plaintext is required');
    const scope = this.#scope({ tenantId, projectId, purpose });
    const head = epoch === null ? await this.ensureEpoch({ ...scope, actor }) : null;
    const resolved = await this.#keyFor(scope, epoch === null ? head.epoch : epoch);
    const nonce = crypto.randomBytes(12);
    const aad = aadFor({ ...scope, epoch: resolved.row.epoch });
    const cipher = crypto.createCipheriv('aes-256-gcm', resolved.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
    const result = { version: 1, algorithm: 'AES-256-GCM', keyId: `forge-kms-${scope.purpose}-v${resolved.row.epoch}`, tenantId: scope.tenantId, projectId: scope.projectId, purpose: scope.purpose, epoch: resolved.row.epoch, ciphertext, nonce, authTag: cipher.getAuthTag() };
    resolved.key.fill(0);
    this.metrics.inc('forge_crypto_encrypt_total', { purpose });
    return result;
  }

  async decrypt(record) {
    const scope = this.#scope(record);
    const resolved = await this.#keyFor(scope, Number(record.epoch));
    const aad = aadFor({ ...scope, epoch: resolved.row.epoch });
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', resolved.key, Buffer.from(record.nonce));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(record.authTag || record.auth_tag));
      const plain = Buffer.concat([decipher.update(Buffer.from(record.ciphertext)), decipher.final()]);
      this.metrics.inc('forge_crypto_decrypt_total', { purpose: scope.purpose });
      return plain.toString('utf8');
    } catch {
      this.metrics.inc('forge_crypto_decrypt_failures_total', { purpose: scope.purpose });
      throw fail('ciphertext authentication failed', 'CIPHERTEXT_INVALID', 503);
    } finally { resolved.key.fill(0); }
  }

  async list({ tenantId, projectId = null, purpose = null }) {
    const values = [tenantId, projectId];
    const where = ['tenant_id=$1', 'project_id IS NOT DISTINCT FROM $2'];
    if (purpose) { values.push(purpose); where.push(`purpose=$${values.length}`); }
    return (await this.pool.query(`SELECT tenant_id,project_id,purpose,epoch,status,key_fingerprint,created_by,created_at,activated_at,retiring_at,retired_at,revoked_at,rotation_reason,revocation_reason FROM forge_crypto_key_epochs WHERE ${where.join(' AND ')} ORDER BY purpose,epoch`, values)).rows;
  }

  async health({ tenantId }) {
    const rows = await this.pool.query(`SELECT purpose,max(epoch)::bigint AS active_epoch,count(*)::int AS epoch_count FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND status='ACTIVE' GROUP BY purpose ORDER BY purpose`, [tenantId]);
    return { ok: true, tenantId, activePurposes: rows.rows };
  }
}

class ScopedEnvelopeCipher {
  constructor({ kms, purpose = 'runtime-secret' } = {}) {
    if (!kms) throw new TypeError('kms is required');
    this.kms = kms;
    this.purpose = purpose;
  }
  encrypt(plaintext) {
    const context = KeyManagementService.context();
    if (!context?.tenantId) throw fail('tenant scope required for encryption', 'TENANT_SCOPE_REQUIRED', 403);
    return this.kms.encrypt({ tenantId: context.tenantId, projectId: context.projectId, purpose: context.purpose || this.purpose, plaintext });
  }
  decrypt(record) {
    const context = KeyManagementService.context();
    if (!context?.tenantId) throw fail('tenant scope required for decryption', 'TENANT_SCOPE_REQUIRED', 403);
    return this.kms.decrypt({ ...record, tenantId: context.tenantId, projectId: context.projectId, purpose: context.purpose || this.purpose });
  }
}

module.exports = { KeyManagementService, ScopedEnvelopeCipher, KEY_PURPOSES, fail };
