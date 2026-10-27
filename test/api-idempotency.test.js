const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalJson,
  sha256,
  redact,
  validateContext,
  acquireResourceFence,
  recordCallbackReceipt,
  markCallbackApplied,
} = require('../src/persistence/api-idempotency');

test('canonical JSON is deterministic across object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
});

test('redaction removes credentials from persisted outcomes', () => {
  const safe = redact({ token: 'secret', nested: { password: 'pw' }, value: 'keep' });
  assert.deepEqual(safe, { token: '[REDACTED]', nested: { password: '[REDACTED]' }, value: 'keep' });
});

test('idempotency scope requires tenant or project and validates key bounds', () => {
  assert.throws(() => validateContext({ idempotencyKey: 'short', operation: 'x', tenantId: 't' }), /between 8 and 255/);
  assert.throws(() => validateContext({ idempotencyKey: 'abcdefgh', operation: 'x' }), /tenant or project scope/);
  const context = validateContext({ idempotencyKey: 'abcdefgh', operation: 'episode.publish', tenantId: 't1', projectId: 'p1', request: { b: 2, a: 1 } });
  assert.equal(context.requestHash, sha256({ a: 1, b: 2 }));
});

function fakeClient() {
  const rows = [];
  const fences = [];
  const receipts = [];
  return {
    rows,
    fences,
    receipts,
    async query(sql, values = []) {
      if (/INSERT INTO forge_resource_fences/.test(sql)) {
        const [tenantId, projectId, resourceType, resourceId] = values;
        const existing = fences.find((x) => x.tenant_id === tenantId && x.project_id === projectId && x.resource_type === resourceType && x.resource_id === resourceId);
        if (existing) return { rows: [] };
        const row = { id: fences.length + 1, tenant_id: tenantId, project_id: projectId, resource_type: resourceType, resource_id: resourceId, version: 0, epoch: 1 };
        fences.push(row); return { rows: [row] };
      }
      if (/SELECT \* FROM forge_resource_fences/.test(sql)) {
        const [tenantId, projectId, resourceType, resourceId] = values;
        return { rows: fences.filter((x) => x.tenant_id === tenantId && x.project_id === projectId && x.resource_type === resourceType && x.resource_id === resourceId) };
      }
      if (/UPDATE forge_resource_fences/.test(sql)) {
        const row = fences.find((x) => x.id === values[0]); row.version += 1; return { rows: [row] };
      }
      if (/INSERT INTO forge_callback_receipts/.test(sql)) {
        const [tenantId, projectId, source, externalEventId, payloadHash, attemptId, observedEpoch] = values;
        const existing = receipts.find((x) => x.tenant_id === tenantId && x.project_id === projectId && x.source === source && x.external_event_id === externalEventId);
        if (existing) return { rows: [] };
        const row = { id: receipts.length + 1, tenant_id: tenantId, project_id: projectId, source, external_event_id: externalEventId, payload_hash: payloadHash, attempt_id: attemptId, observed_epoch: observedEpoch, status: 'ACCEPTED' };
        receipts.push(row); return { rows: [row] };
      }
      if (/SELECT \* FROM forge_callback_receipts/.test(sql)) {
        const [tenantId, projectId, source, externalEventId] = values;
        return { rows: receipts.filter((x) => x.tenant_id === tenantId && x.project_id === projectId && x.source === source && x.external_event_id === externalEventId) };
      }
      if (/UPDATE forge_callback_receipts/.test(sql)) {
        const [status, details, id] = values; const row = receipts.find((x) => x.id === id); row.status = status; row.details = details; if (status === 'APPLIED') row.applied_at = true; return { rows: [row] };
      }
      throw new Error(`Unhandled fake SQL: ${sql}`);
    },
  };
}

test('resource fences serialize version and epoch checks', async () => {
  const client = fakeClient();
  const first = await acquireResourceFence(client, { tenantId: 't1', resourceType: 'publish', resourceId: 'e1' });
  assert.equal(Number(first.version), 1);
  const second = await acquireResourceFence(client, { tenantId: 't1', resourceType: 'publish', resourceId: 'e1', expectedVersion: 1, expectedEpoch: 1 });
  assert.equal(Number(second.version), 2);
  await assert.rejects(() => acquireResourceFence(client, { tenantId: 't1', resourceType: 'publish', resourceId: 'e1', expectedVersion: 1 }), /Resource version conflict/);
});

test('callback receipts are one-time and can be marked applied', async () => {
  const client = fakeClient();
  const first = await recordCallbackReceipt(client, { tenantId: 't1', source: 'runner', externalEventId: 'evt-1', payload: { status: 'SUCCEEDED' } });
  assert.equal(first.duplicate, false);
  const duplicate = await recordCallbackReceipt(client, { tenantId: 't1', source: 'runner', externalEventId: 'evt-1', payload: { status: 'SUCCEEDED' } });
  assert.equal(duplicate.duplicate, true);
  await markCallbackApplied(client, first.row.id, 'APPLIED', { redacted: true });
  assert.equal(client.receipts[0].status, 'APPLIED');
});
