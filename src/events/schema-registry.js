'use strict';

const crypto = require('node:crypto');

const MODES = new Set(['BACKWARD', 'FORWARD', 'FULL', 'NONE']);
const UNKNOWN_POLICIES = new Set(['REJECT', 'ALLOW']);
const ACTIVE_STATES = new Set(['ACTIVE']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

function canonicalSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprintSchema(schema) {
  return crypto.createHash('sha256').update(canonicalSerialize(schema)).digest('hex');
}

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(value, candidate));
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validateValue(value, schema, path = '$', options = {}) {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if (schema.type && !typeMatches(value, schema.type)) errors.push({ code: 'TYPE_MISMATCH', path, expected: schema.type });
  if (schema.enum && !schema.enum.some((candidate) => canonicalSerialize(candidate) === canonicalSerialize(value))) errors.push({ code: 'ENUM_MISMATCH', path });
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && canonicalSerialize(schema.const) !== canonicalSerialize(value)) errors.push({ code: 'CONST_MISMATCH', path });
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (value[key] === undefined || value[key] === null) errors.push({ code: 'REQUIRED_FIELD_MISSING', path: `${path}.${key}` });
    const unknown = Object.keys(value).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
    const policy = options.unknownFieldPolicy || (schema.additionalProperties === false ? 'REJECT' : 'ALLOW');
    if (unknown.length && policy === 'REJECT') errors.push({ code: 'UNKNOWN_FIELD', path, fields: unknown.sort() });
    for (const [key, child] of Object.entries(properties)) if (value[key] !== undefined && value[key] !== null) errors.push(...validateValue(value[key], child, `${path}.${key}`, options));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of unknown) errors.push(...validateValue(value[key], schema.additionalProperties, `${path}.${key}`, options));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validateValue(item, schema.items, `${path}[${index}]`, options)));
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) errors.push({ code: 'MIN_LENGTH', path });
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) errors.push({ code: 'MAX_LENGTH', path });
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errors.push({ code: 'MINIMUM', path });
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) errors.push({ code: 'MAXIMUM', path });
  return errors;
}

function schemaTypeSet(schema) {
  const type = schema?.type;
  if (!type) return new Set(['any']);
  return new Set(Array.isArray(type) ? type : [type]);
}

function typeCompatible(oldSchema, newSchema) {
  const oldTypes = schemaTypeSet(oldSchema);
  const newTypes = schemaTypeSet(newSchema);
  if (oldTypes.has('any') || newTypes.has('any')) return true;
  for (const type of oldTypes) if (newTypes.has(type)) return true;
  return false;
}

function objectBackwardCompatible(oldSchema, newSchema, path, reasons) {
  const oldProps = oldSchema.properties || {};
  const newProps = newSchema.properties || {};
  const oldRequired = new Set(oldSchema.required || []);
  const newRequired = new Set(newSchema.required || []);
  for (const key of newRequired) {
    if (!oldRequired.has(key)) reasons.push(`new required field ${path}.${key}`);
  }
  if (newSchema.additionalProperties === false) {
    const oldUnknownAllowed = oldSchema.additionalProperties !== false;
    if (oldUnknownAllowed) reasons.push(`new schema rejects unknown fields at ${path}`);
  }
  for (const [key, oldChild] of Object.entries(oldProps)) {
    if (!newProps[key]) {
      if (oldRequired.has(key) && newSchema.additionalProperties === false) reasons.push(`removed required field ${path}.${key}`);
      continue;
    }
    if (!typeCompatible(oldChild, newProps[key])) reasons.push(`incompatible type at ${path}.${key}`);
    compareSchemas(oldChild, newProps[key], `${path}.${key}`, 'BACKWARD', reasons);
  }
}

function objectForwardCompatible(oldSchema, newSchema, path, reasons) {
  const oldProps = oldSchema.properties || {};
  const newProps = newSchema.properties || {};
  const oldRequired = new Set(oldSchema.required || []);
  const newRequired = new Set(newSchema.required || []);
  for (const key of oldRequired) if (!newRequired.has(key)) reasons.push(`new schema may omit old required field ${path}.${key}`);
  if (oldSchema.additionalProperties === false) {
    const newUnknownAllowed = newSchema.additionalProperties !== false;
    if (newUnknownAllowed) reasons.push(`new schema allows fields rejected by old schema at ${path}`);
  }
  for (const [key, newChild] of Object.entries(newProps)) {
    if (!oldProps[key]) {
      if (newRequired.has(key) && oldSchema.additionalProperties === false) reasons.push(`new required field rejected by old schema ${path}.${key}`);
      continue;
    }
    if (!typeCompatible(oldProps[key], newChild)) reasons.push(`incompatible type at ${path}.${key}`);
    compareSchemas(oldProps[key], newChild, `${path}.${key}`, 'FORWARD', reasons);
  }
}

function compareSchemas(oldSchema, newSchema, path = '$', mode = 'BACKWARD', reasons = []) {
  if (!oldSchema || !newSchema) return reasons;
  if (!typeCompatible(oldSchema, newSchema)) reasons.push(`incompatible type at ${path}`);
  if (oldSchema.type === 'object' && newSchema.type === 'object') {
    if (mode === 'BACKWARD') objectBackwardCompatible(oldSchema, newSchema, path, reasons);
    if (mode === 'FORWARD') objectForwardCompatible(oldSchema, newSchema, path, reasons);
  }
  if (oldSchema.enum && newSchema.enum) {
    const newValues = new Set(newSchema.enum.map(canonicalSerialize));
    if (mode === 'BACKWARD' && oldSchema.enum.some((v) => !newValues.has(canonicalSerialize(v)))) reasons.push(`enum value removed at ${path}`);
    if (mode === 'FORWARD' && newSchema.enum.some((v) => !oldSchema.enum.map(canonicalSerialize).includes(canonicalSerialize(v)))) reasons.push(`enum value added at ${path}`);
  }
  return reasons;
}

function checkCompatibility(previousSchema, candidateSchema, mode) {
  if (!MODES.has(mode)) throw new TypeError(`Unsupported compatibility mode: ${mode}`);
  if (mode === 'NONE') return { compatible: true, reasons: [] };
  const reasons = [];
  if (mode === 'BACKWARD' || mode === 'FULL') compareSchemas(previousSchema, candidateSchema, '$', 'BACKWARD', reasons);
  if (mode === 'FORWARD' || mode === 'FULL') compareSchemas(previousSchema, candidateSchema, '$', 'FORWARD', reasons);
  return { compatible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function registryError(message, code = 'SCHEMA_REGISTRY_ERROR', statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, details });
}

class EventSchemaRegistry {
  constructor({ pool, logger = console, clock = () => new Date() } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool required');
    this.pool = pool;
    this.logger = logger;
    this.clock = clock;
  }

  async getFamily(eventFamily, tenantId = null, client = this.pool) {
    return (await client.query(`SELECT * FROM forge_event_schema_families WHERE event_family=$1 AND (tenant_id=$2 OR (tenant_id IS NULL AND $2::text IS NULL))`, [eventFamily, tenantId])).rows[0] || null;
  }

  async getSchema(eventFamily, version, tenantId = null, client = this.pool) {
    return (await client.query(`SELECT s.*,f.event_family,f.tenant_id,f.compatibility_mode,f.unknown_field_policy FROM forge_event_schemas s JOIN forge_event_schema_families f ON f.id=s.family_id WHERE f.event_family=$1 AND s.version=$2 AND (f.tenant_id=$3 OR (f.tenant_id IS NULL AND $3::text IS NULL))`, [eventFamily, version, tenantId])).rows[0] || null;
  }

  async register({ eventFamily, version, schema, tenantId = null, compatibilityMode = 'BACKWARD', unknownFieldPolicy = 'REJECT', producerOwner, consumerOwners = [], effectiveAt = null, migrationMetadata = {}, actor = 'operator', activate = false }) {
    if (!eventFamily || !Number.isInteger(version) || version < 1 || !schema || typeof schema !== 'object') throw registryError('eventFamily, positive version and schema are required', 'INVALID_SCHEMA_REGISTRATION');
    if (!MODES.has(compatibilityMode) || !UNKNOWN_POLICIES.has(unknownFieldPolicy)) throw registryError('Invalid compatibility or unknown-field policy', 'INVALID_SCHEMA_POLICY');
    const fingerprint = fingerprintSchema(schema);
    const familyKey = `${tenantId || '__GLOBAL__'}:${eventFamily}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [familyKey]);
      let family = await this.getFamily(eventFamily, tenantId, client);
      if (!family) {
        family = (await client.query(`INSERT INTO forge_event_schema_families(id,tenant_id,event_family,compatibility_mode,unknown_field_policy,producer_owner,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [`esf_${crypto.randomUUID()}`, tenantId, eventFamily, compatibilityMode, unknownFieldPolicy, producerOwner || 'unknown', actor])).rows[0];
      } else {
        await client.query(`UPDATE forge_event_schema_families SET compatibility_mode=$2,unknown_field_policy=$3,producer_owner=COALESCE($4,producer_owner),updated_at=now() WHERE id=$1`, [family.id, compatibilityMode, unknownFieldPolicy, producerOwner || null]);
      }
      const existing = (await client.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND version=$2 FOR UPDATE`, [family.id, version])).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw registryError(`Version ${version} already exists with a different fingerprint`, 'DUPLICATE_SCHEMA_VERSION', 409, { eventFamily, version, fingerprint: existing.fingerprint });
        await client.query('COMMIT');
        return existing;
      }
      const latest = (await client.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 ORDER BY version DESC LIMIT 1`, [family.id])).rows[0];
      if (latest) {
        const compatibility = checkCompatibility(latest.schema, schema, compatibilityMode);
        if (!compatibility.compatible) throw registryError(`Schema ${eventFamily} v${version} is incompatible with v${latest.version}`, 'SCHEMA_INCOMPATIBLE', 409, { previousVersion: latest.version, reasons: compatibility.reasons });
      }
      const id = `ess_${crypto.randomUUID()}`;
      const status = activate ? 'ACTIVE' : 'DRAFT';
      const row = (await client.query(`INSERT INTO forge_event_schemas(id,family_id,version,schema,fingerprint,status,effective_at,producer_owner,consumer_owners,migration_metadata,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`, [id, family.id, version, JSON.stringify(schema), fingerprint, status, effectiveAt || (activate ? this.clock() : null), producerOwner || family.producer_owner, consumerOwners, JSON.stringify(migrationMetadata), actor])).rows[0];
      if (activate) await this.activateInTransaction(client, family, row, actor);
      await client.query(`INSERT INTO forge_event_schema_audit(family_id,schema_id,tenant_id,actor,action,to_version,compatibility_mode,details) VALUES($1,$2,$3,$4,'REGISTERED',$5,$6,$7::jsonb)`, [family.id, row.id, tenantId, actor, version, compatibilityMode, JSON.stringify({ fingerprint, activated: activate })]);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async activateInTransaction(client, family, schema, actor) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${family.tenant_id || '__GLOBAL__'}:${family.event_family}`]);
    const active = (await client.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND status='ACTIVE' AND id<>$2 FOR UPDATE`, [family.id, schema.id])).rows[0];
    if (active) {
      await client.query(`UPDATE forge_event_schemas SET status='DEPRECATED',deprecated_at=COALESCE(deprecated_at,now()),updated_at=now() WHERE id=$1`, [active.id]);
      await client.query(`INSERT INTO forge_event_schema_audit(family_id,schema_id,tenant_id,actor,action,from_version,to_version,compatibility_mode,details) VALUES($1,$2,$3,$4,'ACTIVATED',$5,$6,$7,$8::jsonb)`, [family.id, schema.id, family.tenant_id, actor, active.version, schema.version, family.compatibility_mode, JSON.stringify({ replacedActive: active.id })]);
    }
    await client.query(`UPDATE forge_event_schemas SET status='ACTIVE',effective_at=COALESCE(effective_at,now()),deprecated_at=NULL,updated_at=now() WHERE id=$1`, [schema.id]);
  }

  async activate({ eventFamily, version, tenantId = null, actor = 'operator' }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId || '__GLOBAL__'}:${eventFamily}`]);
      const family = await this.getFamily(eventFamily, tenantId, client);
      const schema = family && (await client.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND version=$2 FOR UPDATE`, [family.id, version])).rows[0];
      if (!family || !schema) throw registryError('Schema version not found', 'SCHEMA_NOT_FOUND', 404);
      if (schema.status === 'REVOKED') throw registryError('Revoked schema cannot be activated', 'SCHEMA_REVOKED', 409);
      const latestActive = (await client.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND status='ACTIVE' AND id<>$2 FOR UPDATE`, [family.id, schema.id])).rows[0];
      if (latestActive) {
        const compatibility = checkCompatibility(latestActive.schema, schema.schema, family.compatibility_mode);
        if (!compatibility.compatible) throw registryError('Activation would violate family compatibility policy', 'SCHEMA_INCOMPATIBLE', 409, { reasons: compatibility.reasons });
      }
      await this.activateInTransaction(client, family, schema, actor);
      await client.query(`INSERT INTO forge_event_schema_audit(family_id,schema_id,tenant_id,actor,action,from_version,to_version,compatibility_mode) VALUES($1,$2,$3,$4,'ACTIVATED',$5,$6,$7)`, [family.id, schema.id, tenantId, actor, latestActive?.version || null, schema.version, family.compatibility_mode]);
      await client.query('COMMIT');
      return schema;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async deprecate({ eventFamily, version, tenantId = null, actor = 'operator', reason = 'operator deprecation' }) {
    const schema = await this.getSchema(eventFamily, version, tenantId);
    if (!schema) throw registryError('Schema version not found', 'SCHEMA_NOT_FOUND', 404);
    const result = await this.pool.query(`UPDATE forge_event_schemas SET status='DEPRECATED',deprecated_at=COALESCE(deprecated_at,now()),updated_at=now() WHERE id=$1 AND status<>'REVOKED' RETURNING *`, [schema.id]);
    await this.pool.query(`INSERT INTO forge_event_schema_audit(family_id,schema_id,tenant_id,actor,action,from_version,to_version,details) VALUES($1,$2,$3,$4,'DEPRECATED',$5,$5,$6::jsonb)`, [schema.family_id, schema.id, tenantId, actor, version, JSON.stringify({ reason })]);
    return result.rows[0];
  }

  async verify({ eventFamily, version, schema, tenantId = null }) {
    const current = await this.getSchema(eventFamily, version, tenantId);
    if (!current) throw registryError('Schema version not found', 'SCHEMA_NOT_FOUND', 404);
    const fingerprint = fingerprintSchema(schema);
    return { compatibleFingerprint: fingerprint === current.fingerprint, fingerprint, registeredFingerprint: current.fingerprint, version, eventFamily };
  }

  async diff({ eventFamily, fromVersion, toVersion, tenantId = null }) {
    const from = await this.getSchema(eventFamily, fromVersion, tenantId);
    const to = await this.getSchema(eventFamily, toVersion, tenantId);
    if (!from || !to) throw registryError('Both schema versions are required', 'SCHEMA_NOT_FOUND', 404);
    const family = await this.getFamily(eventFamily, tenantId);
    return { eventFamily, fromVersion, toVersion, backward: checkCompatibility(from.schema, to.schema, 'BACKWARD'), forward: checkCompatibility(from.schema, to.schema, 'FORWARD'), full: checkCompatibility(from.schema, to.schema, 'FULL'), familyMode: family.compatibility_mode };
  }

  async negotiate({ eventFamily, tenantId = null, consumerId, supportedVersions }) {
    const family = await this.getFamily(eventFamily, tenantId);
    if (!family) throw registryError('Event family not registered', 'SCHEMA_FAMILY_NOT_FOUND', 404);
    const versions = [...new Set((supportedVersions || []).filter((v) => Number.isInteger(v)))].sort((a, b) => b - a);
    if (!versions.length) throw registryError('Consumer must advertise supported versions', 'NO_SUPPORTED_VERSIONS');
    const rows = (await this.pool.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND status='ACTIVE' ORDER BY version DESC`, [family.id])).rows;
    const chosen = rows.find((row) => versions.includes(row.version));
    if (!chosen) throw registryError(`No active version supported by consumer ${consumerId || 'unknown'}`, 'NO_NEGOTIATED_VERSION', 409, { activeVersions: rows.map((r) => r.version), supportedVersions: versions });
    await this.pool.query(`INSERT INTO forge_event_schema_consumers(id,family_id,tenant_id,consumer_id,owner,supported_versions,preferred_version,minimum_version,maximum_version,last_seen_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$4) ON CONFLICT(family_id,tenant_id,consumer_id) DO UPDATE SET supported_versions=EXCLUDED.supported_versions,preferred_version=EXCLUDED.preferred_version,minimum_version=EXCLUDED.minimum_version,maximum_version=EXCLUDED.maximum_version,last_seen_at=now(),updated_at=now()`, [`esc_${crypto.randomUUID()}`, family.id, tenantId, consumerId || 'anonymous', consumerId || 'unknown', versions, chosen.version, Math.min(...versions), Math.max(...versions)]);
    return { eventFamily, version: chosen.version, fingerprint: chosen.fingerprint, consumerId: consumerId || 'anonymous' };
  }

  async validate({ eventFamily, version, payload, tenantId = null, source = 'runtime', sourceId = null, projectId = null, quarantine = true }) {
    const family = await this.getFamily(eventFamily, tenantId);
    const schema = family && (await this.pool.query(`SELECT * FROM forge_event_schemas WHERE family_id=$1 AND version=$2`, [family.id, version])).rows[0];
    if (!family || !schema) throw registryError(`Unknown event contract ${eventFamily} v${version}`, 'SCHEMA_NOT_FOUND', 409);
    const now = this.clock();
    if (schema.status === 'REVOKED' || (schema.deprecated_at && new Date(schema.deprecated_at) <= now && schema.status !== 'ACTIVE')) throw registryError(`Deprecated or revoked event contract ${eventFamily} v${version}`, 'SCHEMA_DEPRECATED', 409);
    const errors = validateValue(payload, schema.schema, '$', { unknownFieldPolicy: family.unknown_field_policy });
    if (errors.length) {
      if (quarantine) await this.quarantine({ tenantId, projectId, eventFamily, version, payload, reasonCode: errors[0].code, reason: JSON.stringify(errors).slice(0, 4000), source, sourceId });
      throw registryError(`Event payload rejected by ${eventFamily} v${version}`, 'SCHEMA_VALIDATION_FAILED', 409, { errors, fingerprint: schema.fingerprint });
    }
    return { schema, fingerprint: schema.fingerprint, canonicalPayload: canonicalize(payload) };
  }

  async quarantine({ tenantId = null, projectId = null, eventFamily, version = null, payload, reasonCode, reason, source = 'runtime', sourceId = null, replayOf = null }) {
    const id = `esq_${crypto.randomUUID()}`;
    const digest = crypto.createHash('sha256').update(canonicalSerialize(payload || {})).digest('hex');
    await this.pool.query(`INSERT INTO forge_event_schema_quarantine(id,tenant_id,project_id,event_family,event_version,payload,payload_fingerprint,reason_code,reason,source,source_id,replay_of) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`, [id, tenantId, projectId, eventFamily, version, JSON.stringify(payload || {}), digest, reasonCode, reason, source, sourceId, replayOf]);
    return id;
  }

  async inventory({ tenantId = null, eventFamily = null }) {
    const args = []; const where = [];
    if (tenantId) { args.push(tenantId); where.push(`(c.tenant_id=$${args.length} OR c.tenant_id IS NULL)`); }
    if (eventFamily) { args.push(eventFamily); where.push(`f.event_family=$${args.length}`); }
    const result = await this.pool.query(`SELECT c.*,f.event_family,f.compatibility_mode,f.unknown_field_policy FROM forge_event_schema_consumers c JOIN forge_event_schema_families f ON f.id=c.family_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.event_family,c.consumer_id`, args);
    return result.rows;
  }

  async health({ tenantId = null } = {}) {
    const args = tenantId ? [tenantId] : [];
    const where = tenantId ? 'WHERE f.tenant_id=$1 OR f.tenant_id IS NULL' : '';
    const counts = await this.pool.query(`SELECT f.event_family,count(s.*)::int AS versions,count(*) FILTER (WHERE s.status='ACTIVE')::int AS active_versions FROM forge_event_schema_families f LEFT JOIN forge_event_schemas s ON s.family_id=f.id ${where} GROUP BY f.id ORDER BY f.event_family`, args);
    const quarantine = await this.pool.query(`SELECT count(*)::int AS count FROM forge_event_schema_quarantine ${tenantId ? 'WHERE tenant_id=$1' : ''} AND released_at IS NULL`, args);
    return { families: counts.rows, openQuarantine: quarantine.rows[0]?.count || 0 };
  }
}

module.exports = { EventSchemaRegistry, canonicalize, canonicalSerialize, fingerprintSchema, validateValue, checkCompatibility, MODES, UNKNOWN_POLICIES };
