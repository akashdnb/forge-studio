'use strict';

const crypto = require('node:crypto');

const SECRET_KEY = /(token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;
const CONTRACT_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(JSON.stringify(canonical(value))).digest('hex'); }
function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string' && (value.length > 2048 || /^(bearer\s+|AKIA|gh[pousr]_)/i.test(value))) return '[REDACTED]';
  return value;
}
function fail(code, message, details = {}) { return Object.assign(new Error(message), { code, statusCode: code.startsWith('CONTRACT_') ? 422 : 503, retryable: false, details }); }
function matchesSchema(value, schema, path = '$') {
  if (!schema) return [];
  const errors = [];
  if (schema.type) {
    const ok = schema.type === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : schema.type === 'array' ? Array.isArray(value) : schema.type === 'string' ? typeof value === 'string' : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'boolean' ? typeof value === 'boolean' : true;
    if (!ok) return [`${path}: expected ${schema.type}`];
  }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${path}: value not in enum`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) errors.push(...matchesSchema(value[key], child, `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key}: unknown field`);
  }
  if (schema.type === 'array' && Array.isArray(value)) for (let i = 0; i < value.length; i += 1) errors.push(...matchesSchema(value[i], schema.items, `${path}[${i}]`));
  if (typeof value === 'string') { if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: too short`); if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: too long`); }
  if (typeof value === 'number') { if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum`); if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum`); }
  return errors;
}
function normalizeContract(input) {
  if (!input || typeof input !== 'object') throw new TypeError('provider contract is required');
  const contract = { schemaVersion: CONTRACT_SCHEMA_VERSION, provider: String(input.provider || ''), contractVersion: String(input.contractVersion || ''), capability: String(input.capability || ''), operations: [...new Set((input.operations || []).map(String))].sort(), models: [...new Set((input.models || []).map(String))].sort(), inputSchema: input.inputSchema || null, outputSchema: input.outputSchema || null, limits: input.limits || {}, mediaFormats: [...new Set((input.mediaFormats || []).map(String))].sort(), latency: input.latency || {}, timeoutMs: Number(input.timeoutMs || 0), idempotency: input.idempotency || 'UNKNOWN', regions: [...new Set((input.regions || []).map(String))].sort(), credentialRequirements: redact(input.credentialRequirements || {}), apiVersion: input.apiVersion ? String(input.apiVersion) : null, validUntil: input.validUntil || null, metadata: redact(input.metadata || {}) };
  if (!contract.provider || !contract.contractVersion || !contract.capability || !contract.operations.length) throw new TypeError('provider, contractVersion, capability and operations are required');
  return contract;
}
class ProviderContractService {
  constructor({ pool, signingSecret = process.env.FORGE_PROVIDER_CONTRACT_SIGNING_SECRET, metrics = null, logger = console, clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    if (!signingSecret) throw new TypeError('FORGE_PROVIDER_CONTRACT_SIGNING_SECRET is required');
    this.pool = pool; this.signingSecret = signingSecret; this.metrics = metrics || { increment() {}, gauge() {} }; this.logger = logger; this.clock = clock; this.ttlMs = ttlMs;
  }
  signedPayload(contract) { return { ...contract, contractHash: digest(contract) }; }
  sign(contract) { return sign(this.signedPayload(contract), this.signingSecret); }
  verifySignature(contract, signature) { const expected = this.sign(contract); const actual = String(signature || ''); return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual)); }
  async upsert({ contract, actor = 'system' } = {}) { const normalized = normalizeContract(contract); const payload = this.signedPayload(normalized); const signature = this.sign(normalized); const result = await this.pool.query(`INSERT INTO forge_provider_contracts(provider,capability,contract_version,contract_hash,schema_version,contract,signature,status,valid_until,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'ACTIVE',$8,$9) ON CONFLICT(provider,capability,contract_version) DO UPDATE SET contract_hash=EXCLUDED.contract_hash,contract=EXCLUDED.contract,signature=EXCLUDED.signature,status='ACTIVE',valid_until=EXCLUDED.valid_until,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [normalized.provider, normalized.capability, normalized.contractVersion, payload.contractHash, normalized.schemaVersion, JSON.stringify(payload), signature, normalized.validUntil || null, actor]); return result.rows[0]; }
  async get(provider, capability, contractVersion) { return (await this.pool.query(`SELECT * FROM forge_provider_contracts WHERE provider=$1 AND capability=$2 AND contract_version=$3`, [provider, capability, contractVersion])).rows[0] || null; }
  async active(provider, capability) { return (await this.pool.query(`SELECT * FROM forge_provider_contracts WHERE provider=$1 AND capability=$2 AND status='ACTIVE' ORDER BY contract_version DESC, id DESC`, [provider, capability])).rows; }
  async validateRow(row, context = {}) {
    if (!row) return { ok: false, reason: 'MISSING_CONTRACT' };
    const contract = normalizeContract(row.contract);
    if (Number(row.schema_version) !== CONTRACT_SCHEMA_VERSION) return { ok: false, reason: 'SCHEMA_VERSION_UNSUPPORTED' };
    if (row.contract_hash !== digest(contract)) return { ok: false, reason: 'CONTRACT_HASH_MISMATCH' };
    if (!this.verifySignature(contract, row.signature)) return { ok: false, reason: 'INVALID_SIGNATURE' };
    if (row.status !== 'ACTIVE') return { ok: false, reason: `CONTRACT_${row.status}` };
    if (row.valid_until && new Date(row.valid_until).getTime() <= this.clock()) return { ok: false, reason: 'STALE_CONTRACT' };
    if (contract.regions.length && context.region && !contract.regions.includes(context.region)) return { ok: false, reason: 'REGION_UNSUPPORTED' };
    return { ok: true, contract, contractHash: row.contract_hash };
  }
  async credentialCompatible(provider, contract, context) {
    const requirements = contract.credentialRequirements || {};
    if (!requirements.name && !requirements.capabilities?.length && requirements.version == null) return true;
    const rows = (await this.pool.query(`SELECT version,capabilities,credential_name FROM forge_provider_credentials WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>now()) ORDER BY version DESC LIMIT 10`, [context.tenantId, context.projectId || null, provider])).rows;
    return rows.some(row => { const caps = Array.isArray(row.capabilities) ? row.capabilities : []; const capabilityOk = (requirements.capabilities || []).every(required => caps.some(c => typeof c === 'string' ? c === required : c.capability === required)); return (!requirements.name || row.credential_name === requirements.name) && capabilityOk && (requirements.version == null || String(row.version) === String(requirements.version)); });
  }
  async quarantine(provider, capability, reason, evidence = {}) { await this.pool.query(`INSERT INTO forge_provider_contract_state(provider,capability,state,reason,evidence) VALUES($1,$2,'QUARANTINED',$3,$4::jsonb) ON CONFLICT(provider,capability) DO UPDATE SET state='QUARANTINED',reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,version=forge_provider_contract_state.version+1,updated_at=now()`, [provider, capability, reason, JSON.stringify(redact(evidence))]); this.metrics.increment('forge_provider_contract_quarantines_total', { provider, capability, reason }); }
  async clearQuarantine(provider, capability, actor = 'operator') { await this.pool.query(`UPDATE forge_provider_contract_state SET state='ACTIVE',reason=NULL,evidence='{}'::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE provider=$1 AND capability=$2`, [provider, capability, actor]); }
  async state(provider, capability) { return (await this.pool.query(`SELECT * FROM forge_provider_contract_state WHERE provider=$1 AND capability=$2`, [provider, capability])).rows[0] || null; }
  async negotiate(candidates, context = {}, request = {}) {
    if (!context.tenantId) return { candidates, decisions: [] };
    const decisions = []; const compatible = [];
    for (const candidate of [...candidates].sort((a,b) => String(a.name).localeCompare(String(b.name)))) {
      const provider = String(candidate.name); const capability = String(context.capability || ''); const state = await this.state(provider, capability);
      if (state?.state === 'QUARANTINED') { decisions.push({ provider, allowed: false, reason: 'QUARANTINED' }); continue; }
      const rows = await this.active(provider, capability); let selected = null; let selectedValidation = null;
      for (const row of rows) {
        const validation = await this.validateRow(row, context); if (!validation.ok) continue;
        if (context.model && validation.contract.models.length && !validation.contract.models.includes(String(context.model))) continue;
        if (context.operation && !validation.contract.operations.includes(String(context.operation))) continue;
        if (candidate.credentialVersion != null && validation.contract.credentialRequirements?.version != null && String(candidate.credentialVersion) !== String(validation.contract.credentialRequirements.version)) continue;
        if (!(await this.credentialCompatible(provider, validation.contract, context))) continue;
        const inputErrors = matchesSchema(request, validation.contract.inputSchema); if (inputErrors.length) { await this.quarantine(provider, capability, 'INPUT_SCHEMA_DRIFT', { errors: inputErrors.slice(0, 8), contractHash: validation.contractHash }); continue; }
        selected = row; selectedValidation = validation; break;
      }
      if (!selected) { decisions.push({ provider, allowed: false, reason: 'NO_COMPATIBLE_CONTRACT' }); continue; }
      compatible.push({ ...candidate, contractVersion: selected.contract_version, contractHash: selected.contract_hash, contract: selectedValidation.contract, contractDecision: 'COMPATIBLE' });
      decisions.push({ provider, allowed: true, contractVersion: selected.contract_version, contractHash: selected.contract_hash });
    }
    if (!compatible.length) { const blocked = { decisions }; await this.recordDecision(context, null, decisions, 'BLOCKED'); throw fail('CONTRACT_INCOMPATIBLE', 'No provider satisfies the versioned capability contract', blocked); }
    const decisionId = digest({ tenantId: context.tenantId, projectId: context.projectId || null, runId: context.runId || null, capability: context.capability, operation: context.operation, model: context.model || '', candidates: decisions });
    await this.recordDecision(context, decisionId, decisions, 'ALLOWED');
    return { candidates: compatible, decisions, decisionId };
  }
  async validateOutput({ provider, capability, contractVersion, output }) {
    const row = await this.get(provider, capability, contractVersion); const validation = await this.validateRow(row, {}); if (!validation.ok) throw fail('CONTRACT_STALE', `Provider contract ${provider}/${capability}/${contractVersion} is no longer valid`, validation);
    const errors = matchesSchema(output, validation.contract.outputSchema); const serialized = Buffer.byteLength(JSON.stringify(output || null)); const maxOutput = Number(validation.contract.limits?.maxOutputBytes || 0); if (maxOutput && serialized > maxOutput) errors.push(`$: output exceeds ${maxOutput} bytes`);
    if (errors.length) { await this.quarantine(provider, capability, 'OUTPUT_SCHEMA_DRIFT', { errors: errors.slice(0, 8), contractVersion }); throw fail('CONTRACT_OUTPUT_INCOMPATIBLE', 'Provider output violated the negotiated contract', { errors: errors.slice(0, 8) }); }
    return true;
  }
  async recordDecision(context, decisionId, decisions, outcome) { const payload = redact({ decisions, outcome, capability: context.capability, operation: context.operation, model: context.model || null, region: context.region || null }); const hash = digest(payload); const signature = sign({ hash, payload }, this.signingSecret); await this.pool.query(`INSERT INTO forge_provider_contract_decisions(decision_id,tenant_id,project_id,run_id,capability,operation,model,decision_hash,decision_signature,outcome,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(decision_id) DO NOTHING`, [decisionId || `blocked:${hash}`, context.tenantId || null, context.projectId || null, context.runId || null, context.capability || null, context.operation || null, context.model || null, hash, signature, outcome, JSON.stringify(payload)]); }
  async startupValidate() { const rows = (await this.pool.query(`SELECT provider,capability,contract_version,contract_hash,contract,schema_version,signature,status,valid_until FROM forge_provider_contracts WHERE status='ACTIVE'`)).rows; const invalid = []; for (const row of rows) { const validation = await this.validateRow(row, {}); if (!validation.ok) invalid.push({ provider: row.provider, capability: row.capability, version: row.contract_version, reason: validation.reason }); } if (invalid.length) throw fail('CONTRACT_STARTUP_INVALID', 'Active provider contracts failed startup verification', { invalid }); return { valid: rows.length, invalid: 0 }; }
}
module.exports = { ProviderContractService, CONTRACT_SCHEMA_VERSION, normalizeContract, matchesSchema, redact };
