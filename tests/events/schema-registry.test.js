'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCompatibility, canonicalSerialize, fingerprintSchema, validateValue, EventSchemaRegistry } = require('../../src/events/schema-registry');

const base = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };

test('canonical serialization and fingerprints are key-order independent', () => {
  assert.equal(canonicalSerialize({ b: 2, a: 1 }), canonicalSerialize({ a: 1, b: 2 }));
  assert.equal(fingerprintSchema({ b: 2, a: 1 }), fingerprintSchema({ a: 1, b: 2 }));
});

test('backward compatibility permits additive optional fields', () => {
  const next = { ...base, properties: { ...base.properties, label: { type: 'string' } } };
  assert.deepEqual(checkCompatibility(base, next, 'BACKWARD'), { compatible: true, reasons: [] });
});

test('backward compatibility rejects newly required fields and type changes', () => {
  const required = { ...base, properties: { ...base.properties, label: { type: 'string' } }, required: ['id', 'label'] };
  assert.equal(checkCompatibility(base, required, 'BACKWARD').compatible, false);
  const changed = { ...base, properties: { id: { type: 'integer' } } };
  assert.equal(checkCompatibility(base, changed, 'BACKWARD').compatible, false);
});

test('full compatibility detects both reader and writer breaks', () => {
  const next = { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false };
  assert.equal(checkCompatibility(base, next, 'FULL').compatible, false);
});

test('unknown-field policy is explicit and deterministic', () => {
  assert.equal(validateValue({ id: 'x', unexpected: true }, base, '$', { unknownFieldPolicy: 'REJECT' })[0].code, 'UNKNOWN_FIELD');
  assert.deepEqual(validateValue({ id: 'x', unexpected: true }, base, '$', { unknownFieldPolicy: 'ALLOW' }), []);
});

test('postgres registry integration and concurrent registration', { skip: !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const registry = new EventSchemaRegistry({ pool });
  const family = `test.event.${Date.now()}`;
  const schema = { ...base, $id: family };
  try {
    const [a, b] = await Promise.allSettled([
      registry.register({ eventFamily: family, version: 1, schema, tenantId: null, producerOwner: 'test', actor: 'test-a' }),
      registry.register({ eventFamily: family, version: 1, schema, tenantId: null, producerOwner: 'test', actor: 'test-b' }),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'fulfilled');
    assert.equal(a.value.fingerprint, b.value.fingerprint);

    await assert.rejects(
      registry.register({ eventFamily: family, version: 1, schema: { ...schema, description: 'different' }, tenantId: null, producerOwner: 'test', actor: 'test-c' }),
      (error) => error.code === 'DUPLICATE_SCHEMA_VERSION',
    );

    const tenantA = `tenant-a-${Date.now()}`;
    const tenantB = `tenant-b-${Date.now()}`;
    const tenantFamily = `${family}.tenant`;
    const sa = await registry.register({ eventFamily: tenantFamily, version: 1, schema, tenantId: tenantA, producerOwner: 'test', actor: 'test-a' });
    const sb = await registry.register({ eventFamily: tenantFamily, version: 1, schema, tenantId: tenantB, producerOwner: 'test', actor: 'test-b' });
    assert.notEqual(sa.family_id, sb.family_id);
    assert.equal((await registry.getSchema(tenantFamily, 1, tenantA)).family_id, sa.family_id);
    assert.equal((await registry.getSchema(tenantFamily, 1, tenantB)).family_id, sb.family_id);
  } finally {
    await pool.query('DELETE FROM forge_event_schema_consumers WHERE family_id IN (SELECT id FROM forge_event_schema_families WHERE event_family LIKE $1)', [`${family}%`]);
    await pool.query('DELETE FROM forge_event_schema_audit WHERE family_id IN (SELECT id FROM forge_event_schema_families WHERE event_family LIKE $1)', [`${family}%`]);
    await pool.query('DELETE FROM forge_event_schemas WHERE family_id IN (SELECT id FROM forge_event_schema_families WHERE event_family LIKE $1)', [`${family}%`]);
    await pool.query('DELETE FROM forge_event_schema_families WHERE event_family LIKE $1', [`${family}%`]);
    await pool.end();
  }
});
