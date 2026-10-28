'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FinalArtifactLifecycleControlPlane } = require('../src/storage/artifact-lifecycle-final-safety');

function makePool(intent) {
  const events = [];
  let txActive = false;
  let lateReferencePromise = null;
  let providerDeleteStarted = false;

  const pool = {
    events,
    async query(sql) {
      if (/UPDATE artifact_deletion_intents SET state='APPROVED'/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT d\.\*,o\.status object_status,o\.storage_key/.test(sql)) return { rows: [intent], rowCount: 1 };
      if (/SELECT count\(\*\)::int count FROM artifact_deletion_intents/.test(sql)) return { rows: [{ count: 0 }], rowCount: 1 };
      if (/UPDATE artifact_gc_generations SET state='COMPLETED'/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN') { txActive = true; events.push('begin'); return { rows: [] }; }
          if (sql === 'COMMIT') { txActive = false; events.push('commit'); return { rows: [] }; }
          if (sql === 'ROLLBACK') { txActive = false; events.push('rollback'); return { rows: [] }; }
          if (/SELECT d\.\*,o\.status,o\.storage_key,o\.sha256,o\.size_bytes/.test(sql)) return { rows: [{ ...intent, status: 'QUARANTINED' }], rowCount: 1 };
          if (/SELECT 1 FROM artifact_storage_reservations/.test(sql)) return { rows: [], rowCount: 0 };
          if (/UPDATE artifact_deletion_intents SET state='DELETING'/.test(sql)) return { rows: [], rowCount: 1 };
          if (/UPDATE artifact_content_objects SET status='DELETED'/.test(sql)) return { rows: [], rowCount: 1 };
          if (/UPDATE artifact_deletion_intents SET state='DELETED'/.test(sql)) return { rows: [], rowCount: 1 };
          throw new Error(`unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
  };

  const storage = {
    async delete() {
      providerDeleteStarted = true;
      events.push('provider-delete');
      lateReferencePromise = (async () => {
        events.push('late-reference-attempt');
        while (txActive) await new Promise(resolve => setImmediate(resolve));
        events.push('late-reference-committed');
      })();
      return undefined;
    },
    async head() { return null; },
  };

  return { pool, storage, getState: () => ({ events, providerDeleteStarted, lateReferencePromise }) };
}

test('GC fences provider deletion against a late A1/V1/C1 delivery reference for P1/R1', async () => {
  const fixture = {
    artifactId: 'A1',
    versionId: 'V1',
    sha256: 'C1',
    packageId: 'P1',
    releaseId: 'R1',
    objectId: 'object:A1',
    intentId: 'intent:A1',
    generationId: 'generation:Y:A1',
    tenantId: 'tenant:Y',
    projectId: 'project:Y',
    storageKey: 'tenant-Y/A1',
  };
  const intent = {
    id: fixture.intentId,
    tenant_id: fixture.tenantId,
    project_id: fixture.projectId,
    object_id: fixture.objectId,
    generation_id: fixture.generationId,
    state: 'APPROVED',
    fence_token: 'fence:A1',
    storage_key: fixture.storageKey,
    sha256: fixture.sha256,
    size_bytes: 11,
    grace_until: new Date(0),
  };
  const { pool, storage, getState } = makePool(intent);
  const service = new FinalArtifactLifecycleControlPlane({ pool, storage });
  service._isProtected = async () => ({ protected: false });
  service._evidence = async () => {};
  service._providerFailure = async (_intent, error) => { throw error; };

  const result = await service.executeApprovedDeletes({ tenantId: fixture.tenantId, generationId: fixture.generationId, actor: 'test', maxDeletes: 1, maxDeleteBytes: 100 });
  const state = getState();
  await state.lateReferencePromise;

  assert.equal(state.providerDeleteStarted, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
  assert.ok(state.events.indexOf('provider-delete') < state.events.indexOf('commit'));
  assert.ok(state.events.indexOf('commit') < state.events.indexOf('late-reference-committed'));
});

test('GC still collects a truly stale A2/V2/C2 package P2/release R2 object', async () => {
  const fixture = {
    artifactId: 'A2',
    versionId: 'V2',
    sha256: 'C2',
    packageId: 'P2',
    releaseId: 'R2',
    objectId: 'object:A2',
    intentId: 'intent:A2',
    generationId: 'generation:Y:A2',
    tenantId: 'tenant:Y',
    projectId: 'project:Y',
    storageKey: 'tenant-Y/A2',
  };
  const intent = {
    id: fixture.intentId,
    tenant_id: fixture.tenantId,
    project_id: fixture.projectId,
    object_id: fixture.objectId,
    generation_id: fixture.generationId,
    state: 'APPROVED',
    fence_token: 'fence:A2',
    storage_key: fixture.storageKey,
    sha256: fixture.sha256,
    size_bytes: 7,
    grace_until: new Date(0),
  };
  const { pool, storage } = makePool(intent);
  const service = new FinalArtifactLifecycleControlPlane({ pool, storage });
  service._isProtected = async () => ({ protected: false });
  service._evidence = async () => {};
  service._providerFailure = async (_intent, error) => { throw error; };

  const result = await service.executeApprovedDeletes({ tenantId: fixture.tenantId, generationId: fixture.generationId, actor: 'test', maxDeletes: 1, maxDeleteBytes: 100 });
  assert.deepEqual(result, {
    generationId: fixture.generationId,
    attempted: 1,
    deleted: 1,
    cancelled: 0,
    failed: 0,
    bytesDeleted: 7,
    remaining: 0,
  });
});
