const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sha256, safeJson, retentionUntil, installInboundEventHardening } = require('../src/events/inbound-event-hardening');

test('inbound hardening helpers are deterministic and bounded', () => {
  assert.equal(sha256('forge'), '4d7f3e2d6c6e0a0c2c8e2a9c7e9b5c5d7b6f3f8f5c6b6f3f7c0a9c2d0e5b8f1');
  assert.deepEqual(safeJson('{"correlationId":"c1"}'), { correlationId: 'c1' });
  assert.deepEqual(safeJson('[]'), {});
  assert.deepEqual(safeJson('{bad'), {});
  const retained = retentionUntil(Date.UTC(2026, 0, 1), 30);
  assert.equal(retained.toISOString(), '2026-01-31T00:00:00.000Z');
});

test('hardening wrapper persists verified intake and duplicate state', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT id,tenant_id,project_id,name,replay_window_seconds')) {
        return { rows: [{ id: 'wh_1', tenant_id: 't_1', project_id: 'p_1', name: 'provider', replay_window_seconds: 300 }] };
      }
      if (sql.includes('INSERT INTO forge_event_intake')) return { rows: [{ intake_id: '00000000-0000-0000-0000-000000000001', processing_state: 'RECEIVED', duplicate_count: 0 }] };
      return { rows: [] };
    }
  };
  class Service {
    constructor() { this.pool = pool; this.now = () => Date.UTC(2026, 0, 1); }
    async ingest() { return { status: 'ACCEPTED', eventId: 'in_1' }; }
  }
  installInboundEventHardening({ InboundWebhookService: Service });
  const service = new Service();
  const result = await service.ingest({ endpointId: 'wh_1', method: 'POST', path: '/webhooks/wh_1/events', timestamp: '1767225600', nonce: 'nonce_12345678', signature: 'v1=' + 'a'.repeat(64), externalEventId: 'evt_1', eventType: 'provider.callback', version: 1, body: '{"providerRunId":"r1","status":"ok"}', contentType: 'application/json' });
  assert.deepEqual(result, { status: 'ACCEPTED', eventId: 'in_1' });
  assert.ok(calls.some(sql => sql.includes("processing_state=$1") || sql.includes("processing_state=$1")));
});

test('migration contains immutable identity, tenant guard and concurrent replay gate', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '120_inbound_event_intake_hardening.sql'), 'utf8');
  assert.match(migration, /forge_event_intake_immutable_guard/);
  assert.match(migration, /forge_event_intake_scope_guard/);
  assert.match(migration, /forge_event_replay_active_uk/);
  assert.match(migration, /PRIMARY KEY\(event_id, route_kind, claim_epoch\)/);
  assert.match(migration, /retention_until timestamptz/);
});
