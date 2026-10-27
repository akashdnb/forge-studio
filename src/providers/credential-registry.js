'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { SecretCipher } = require('../runtime/runtime-policy');

const SAFE_STATUSES = new Set(['ACTIVE', 'OVERLAP', 'RETIRED', 'REVOKED', 'EXPIRED']);
const MUTATING_ACTIONS = new Set(['CREATE', 'ROTATE', 'REVOKE', 'RETIRE', 'TEST']);

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function safeJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key/i.test(key) ? '[REDACTED]' : item));
}
function fail(message, code = 'CREDENTIAL_ERROR', statusCode = 422) { return Object.assign(new Error(message), { code, statusCode }); }
function scopeKey({ tenantId, projectId, provider, credentialName }) { return `credential:${tenantId}:${projectId || '*'}:${provider}:${credentialName}`; }
function confirmToken({ action, credentialId, version }) { return sha256(`${action}:${credentialId}:${version}`); }

class ProviderCredentialRegistry {
  constructor({ pool, secretCipher, logger = console, metrics = null, releaseEpoch = null } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    if (!secretCipher) throw new TypeError('secretCipher is required');
    this.pool = pool;
    this.secretCipher = secretCipher instanceof SecretCipher ? secretCipher : new SecretCipher(secretCipher);
    this.logger = logger;
    this.metrics = metrics || { inc() {} };
    this.releaseEpoch = releaseEpoch;
  }

  async #audit(client, event) {
    await client.query(`INSERT INTO forge_provider_credential_audit(tenant_id,project_id,actor,action,credential_id,provider,version,request_id,idempotency_key,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [event.tenantId, event.projectId || null, event.actor || 'system', event.action, event.credentialId || null, event.provider || null, event.version || null, event.requestId || null, event.idempotencyKey || null, event.outcome, JSON.stringify(safeJson(event.details || {}))]);
  }

  #encrypt(material) {
    if (material === undefined || material === null) throw fail('credential material is required', 'CREDENTIAL_MATERIAL_REQUIRED', 400);
    const encrypted = this.secretCipher.encrypt(JSON.stringify(material));
    return { ...encrypted, keyId: 'forge-secret-master-v1' };
  }

  #decrypt(row) {
    try { return JSON.parse(this.secretCipher.decrypt(row)); }
    catch (error) { throw fail('credential ciphertext could not be decrypted', 'CREDENTIAL_DECRYPT_FAILED', 503); }
  }

  async upsertCapability({ provider, capability, model = '', mediaTypes = [], operations = [], metadata = {}, enabled = true, actor = 'system' } = {}) {
    if (!provider || !capability) throw new TypeError('provider and capability are required');
    await this.pool.query(`INSERT INTO forge_provider_capabilities(provider,capability,model,media_types,operations,metadata,enabled,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(provider,capability,model) DO UPDATE SET media_types=EXCLUDED.media_types,operations=EXCLUDED.operations,metadata=EXCLUDED.metadata,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()`, [provider, capability, model, JSON.stringify(mediaTypes), JSON.stringify(operations), JSON.stringify(safeJson(metadata)), Boolean(enabled), actor]);
    return { provider, capability, model, mediaTypes, operations, metadata: safeJson(metadata), enabled: Boolean(enabled) };
  }

  async listCapabilities({ provider = null, capability = null } = {}) {
    const clauses = []; const values = [];
    if (provider) { values.push(provider); clauses.push(`provider=$${values.length}`); }
    if (capability) { values.push(capability); clauses.push(`capability=$${values.length}`); }
    const rows = (await this.pool.query(`SELECT provider,capability,model,media_types,operations,metadata,enabled FROM forge_provider_capabilities ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY provider,capability,model`, values)).rows;
    return rows;
  }

  async #nextVersion(client, scope) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey(scope)]);
    const row = (await client.query(`SELECT COALESCE(max(version),0)::bigint AS version FROM forge_provider_credentials WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND credential_name=$4`, [scope.tenantId, scope.projectId || null, scope.provider, scope.credentialName])).rows[0];
    return Number(row.version || 0) + 1;
  }

  async create({ tenantId, projectId = null, provider, credentialName, material, capabilities = [], metadata = {}, expiresAt = null, actor = 'system', requestId = null, idempotencyKey = null } = {}) {
    if (!tenantId || !provider || !credentialName) throw new TypeError('tenantId, provider and credentialName are required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        const existing = (await client.query('SELECT credential_id,version,outcome FROM forge_provider_credential_audit WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, idempotencyKey])).rows[0];
        if (existing?.credential_id) { await client.query('ROLLBACK'); return this.get({ tenantId, projectId, credentialId: existing.credential_id, includeMaterial: false }); }
      }
      const version = await this.#nextVersion(client, { tenantId, projectId, provider, credentialName });
      const encrypted = this.#encrypt(material);
      const id = randomUUID();
      await client.query(`INSERT INTO forge_provider_credentials(id,tenant_id,project_id,provider,credential_name,version,status,ciphertext,nonce,auth_tag,key_id,capabilities,metadata,created_by,activated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,now(),$14)`, [id, tenantId, projectId, provider, credentialName, version, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId, JSON.stringify(capabilities), JSON.stringify(safeJson(metadata)), actor, expiresAt]);
      await this.#audit(client, { tenantId, projectId, actor, action: 'CREATE', credentialId: id, provider, version, requestId, idempotencyKey, outcome: 'SUCCEEDED', details: { credentialName, capabilities, expiresAt } });
      await client.query('COMMIT');
      this.metrics.inc('forge_provider_credential_operations_total', { action: 'create', outcome: 'success', provider });
      return this.get({ tenantId, projectId, credentialId: id, includeMaterial: false });
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async rotate({ tenantId, projectId = null, credentialId, material, overlapSeconds = 300, capabilities = null, metadata = null, expiresAt = null, actor = 'system', requestId = null, idempotencyKey = null, confirm = false } = {}) {
    if (!confirm) throw fail('rotation requires explicit confirmation', 'CONFIRMATION_REQUIRED', 409);
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 86400) throw new TypeError('overlapSeconds must be 0..86400');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query(`SELECT * FROM forge_provider_credentials WHERE id=$1 AND tenant_id=$2 AND project_id IS NOT DISTINCT FROM $3 FOR UPDATE`, [credentialId, tenantId, projectId || null])).rows[0];
      if (!current) throw fail('credential not found', 'NOT_FOUND', 404);
      if (idempotencyKey) {
        const existing = (await client.query('SELECT credential_id FROM forge_provider_credential_audit WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, idempotencyKey])).rows[0];
        if (existing?.credential_id) { await client.query('ROLLBACK'); return this.get({ tenantId, projectId, credentialId: existing.credential_id }); }
      }
      const expected = confirmToken({ action: 'ROTATE', credentialId: current.id, version: current.version });
      if (typeof confirm !== 'string' || confirm !== expected) throw fail('invalid rotation confirmation', 'CONFIRMATION_INVALID', 409);
      const version = await this.#nextVersion(client, { tenantId, projectId, provider: current.provider, credentialName: current.credential_name });
      const encrypted = this.#encrypt(material);
      const id = randomUUID();
      const overlapUntil = new Date(Date.now() + overlapSeconds * 1000);
      await client.query(`UPDATE forge_provider_credentials SET status=CASE WHEN $1::int=0 THEN 'RETIRED' ELSE 'OVERLAP' END, overlap_until=$2, retired_at=CASE WHEN $1::int=0 THEN now() ELSE NULL END, updated_at=now() WHERE id=$3`, [overlapSeconds, overlapUntil, current.id]);
      await client.query(`INSERT INTO forge_provider_credentials(id,tenant_id,project_id,provider,credential_name,version,status,ciphertext,nonce,auth_tag,key_id,capabilities,metadata,created_by,activated_at,overlap_until,expires_at) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,now(),$14,$15)`, [id, tenantId, projectId, current.provider, current.credential_name, version, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId, JSON.stringify(capabilities || current.capabilities), JSON.stringify(safeJson(metadata || current.metadata)), actor, overlapUntil, expiresAt]);
      await this.#audit(client, { tenantId, projectId, actor, action: 'ROTATE', credentialId: id, provider: current.provider, version, requestId, idempotencyKey, outcome: 'SUCCEEDED', details: { previousCredentialId: current.id, previousVersion: current.version, overlapSeconds } });
      await client.query('COMMIT');
      this.metrics.inc('forge_provider_credential_rotations_total', { provider: current.provider, outcome: 'success' });
      return this.get({ tenantId, projectId, credentialId: id });
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async #transition({ tenantId, projectId, credentialId, actor, action, confirm, requestId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM forge_provider_credentials WHERE id=$1 AND tenant_id=$2 AND project_id IS NOT DISTINCT FROM $3 FOR UPDATE', [credentialId, tenantId, projectId || null])).rows[0];
      if (!row) throw fail('credential not found', 'NOT_FOUND', 404);
      if (!MUTATING_ACTIONS.has(action)) throw new Error('unsupported credential action');
      const expected = confirmToken({ action, credentialId: row.id, version: row.version });
      if (confirm !== expected) throw fail('invalid confirmation', 'CONFIRMATION_INVALID', 409);
      const target = action === 'REVOKE' ? 'REVOKED' : 'RETIRED';
      await client.query(`UPDATE forge_provider_credentials SET status=$1,retired_at=CASE WHEN $1 IN ('RETIRED','REVOKED') THEN now() ELSE retired_at END,revoked_at=CASE WHEN $1='REVOKED' THEN now() ELSE revoked_at END,updated_at=now() WHERE id=$2`, [target, credentialId]);
      await this.#audit(client, { tenantId, projectId, actor, action, credentialId, provider: row.provider, version: row.version, requestId, outcome: 'SUCCEEDED', details: {} });
      await client.query('COMMIT');
      return this.get({ tenantId, projectId, credentialId });
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async revoke(args) { return this.#transition({ ...args, action: 'REVOKE' }); }
  async retire(args) { return this.#transition({ ...args, action: 'RETIRE' }); }

  async get({ tenantId, projectId = null, credentialId, includeMaterial = false } = {}) {
    const row = (await this.pool.query(`SELECT id,tenant_id,project_id,provider,credential_name,version,status,capabilities,metadata,key_id,created_by,created_at,activated_at,overlap_until,expires_at,retired_at,revoked_at FROM forge_provider_credentials WHERE id=$1 AND tenant_id=$2 AND project_id IS NOT DISTINCT FROM $3`, [credentialId, tenantId, projectId || null])).rows[0];
    if (!row) throw fail('credential not found', 'NOT_FOUND', 404);
    return row;
  }

  async selectAndLease({ tenantId, projectId = null, provider, credentialName, capability, model = '', resourceType, resourceId, releaseEpoch = null, leaseSeconds = 900 } = {}) {
    if (!tenantId || !provider || !resourceType || !resourceId) throw new TypeError('tenantId, provider, resourceType and resourceId are required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey({ tenantId, projectId, provider, credentialName: credentialName || '*' })]);
      await client.query(`UPDATE forge_provider_credentials SET status='RETIRED',retired_at=now(),updated_at=now() WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND status='OVERLAP' AND overlap_until IS NOT NULL AND overlap_until<=now()`, [tenantId, projectId || null, provider]);
      const row = (await client.query(`SELECT * FROM forge_provider_credentials WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND ($4::text IS NULL OR credential_name=$4) AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>now()) ORDER BY version DESC LIMIT 1 FOR UPDATE`, [tenantId, projectId || null, provider, credentialName || null])).rows[0];
      if (!row) throw fail(`no active credential for provider ${provider}`, 'CREDENTIAL_UNAVAILABLE', 503);
      const caps = Array.isArray(row.capabilities) ? row.capabilities : [];
      const matches = caps.some(c => typeof c === 'string' ? c === capability : c.capability === capability && (!model || !c.model || c.model === model));
      const declared = (await client.query(`SELECT 1 FROM forge_provider_capabilities WHERE provider=$1 AND capability=$2 AND model=$3 AND enabled=true`, [provider, capability || '', model || ''])).rows[0];
      if (capability && (!matches || !declared)) throw fail(`credential capability mismatch for ${provider}/${capability}${model ? `/${model}` : ''}`, 'CAPABILITY_MISMATCH', 422);
      if (releaseEpoch && this.releaseEpoch && releaseEpoch !== this.releaseEpoch) throw fail('credential lease release epoch is stale', 'STALE_RELEASE_EPOCH', 409);
      const existing = (await client.query(`SELECT * FROM forge_provider_credential_leases WHERE credential_id=$1 AND resource_type=$2 AND resource_id=$3 FOR UPDATE`, [row.id, resourceType, resourceId])).rows[0];
      if (existing && existing.state === 'HELD' && existing.expires_at > new Date()) {
        await client.query('COMMIT');
        return { leaseId: existing.id, credentialId: row.id, version: row.version, material: this.#decrypt(row), releaseEpoch: existing.release_epoch };
      }
      const leaseId = randomUUID();
      await client.query(`INSERT INTO forge_provider_credential_leases(id,credential_id,tenant_id,project_id,provider,version,resource_type,resource_id,release_epoch,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'HELD',now()+($10::int*interval '1 second'))`, [leaseId, row.id, tenantId, projectId, provider, row.version, resourceType, resourceId, releaseEpoch, leaseSeconds]);
      await client.query('COMMIT');
      this.metrics.inc('forge_provider_credential_leases_total', { provider, outcome: 'acquired' });
      return { leaseId, credentialId: row.id, version: row.version, material: this.#decrypt(row), releaseEpoch };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} this.metrics.inc('forge_provider_credential_leases_total', { provider, outcome: 'rejected' }); throw error; } finally { client.release(); }
  }

  async releaseLease({ tenantId, leaseId, resourceType, resourceId } = {}) {
    const result = await this.pool.query(`UPDATE forge_provider_credential_leases SET state='RELEASED',released_at=now(),heartbeat_at=now() WHERE id=$1 AND tenant_id=$2 AND resource_type=$3 AND resource_id=$4 AND state='HELD' RETURNING id`, [leaseId, tenantId, resourceType, resourceId]);
    return Boolean(result.rowCount);
  }

  async reconcileLeases({ limit = 100 } = {}) {
    const result = await this.pool.query(`UPDATE forge_provider_credential_leases SET state='EXPIRED',released_at=now() WHERE state='HELD' AND expires_at<=now() AND id IN (SELECT id FROM forge_provider_credential_leases WHERE state='HELD' AND expires_at<=now() ORDER BY expires_at LIMIT $1) RETURNING id`, [Math.max(1, Math.min(1000, limit))]);
    return { expired: result.rowCount };
  }

  async test({ tenantId, projectId = null, credentialId, capability, model = '', resourceType = 'credential-test', resourceId = null, actor = 'system', confirm = false, probe } = {}) {
    if (!confirm) throw fail('credential test requires explicit confirmation', 'CONFIRMATION_REQUIRED', 409);
    if (typeof probe !== 'function') throw new TypeError('probe function is required');
    const row = await this.get({ tenantId, projectId, credentialId });
    const lease = await this.selectAndLease({ tenantId, projectId, provider: row.provider, credentialName: row.credential_name, capability, model, resourceType, resourceId: resourceId || `test:${randomUUID()}` });
    try {
      const result = await probe({ provider: row.provider, credentialVersion: lease.version, material: lease.material });
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await this.#audit(client, { tenantId, projectId, actor, action: 'TEST', credentialId, provider: row.provider, version: lease.version, outcome: 'SUCCEEDED', details: { capability, model, result: safeJson(result) } }); await client.query('COMMIT'); } finally { client.release(); }
      return { ok: true, credentialId, version: lease.version, result: safeJson(result) };
    } finally { await this.releaseLease({ tenantId, leaseId: lease.leaseId, resourceType, resourceId: resourceId || lease.leaseId }).catch(() => {}); }
  }
}

module.exports = { ProviderCredentialRegistry, confirmToken, safeJson, sha256 };
