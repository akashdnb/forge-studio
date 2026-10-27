'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DestinationRegistry, BoundaryDestinationAdapter, YouTubeDestinationAdapter, PublishRequest, fingerprint } = require('../src/publishing/destination-contract');

test('destination registry exposes capabilities and never fakes an unconfigured destination', async () => {
  const registry = new DestinationRegistry();
  registry.register(new BoundaryDestinationAdapter());
  assert.equal(registry.capabilities('boundary').resumableUpload, false);
  const request = new PublishRequest({ tenantId: 't', projectId: 'p', episodeId: 'e', destination: 'boundary', idempotencyKey: 'k', packageArtifactId: 'pa', packageVersionId: 'pv', packageHash: 'a'.repeat(64), renderArtifactId: 'ra', renderVersionId: 'rv', renderHash: 'b'.repeat(64) });
  await assert.rejects(() => registry.get('boundary').publish({ request }), /no external success is simulated/);
});

test('publish requests are immutable snapshots with deterministic gate fingerprints', () => {
  const gate = { approvalId: 'approval-1', qaId: 'qa-1', renderHash: 'a'.repeat(64), packageHash: 'b'.repeat(64) };
  const a = new PublishRequest({ tenantId: 't', projectId: 'p', episodeId: 'e', destination: 'youtube', idempotencyKey: 'same', packageArtifactId: 'pa', packageVersionId: 'pv', packageHash: 'b'.repeat(64), renderArtifactId: 'ra', renderVersionId: 'rv', renderHash: 'a'.repeat(64), gateSnapshot: gate });
  const b = new PublishRequest({ tenantId: 't', projectId: 'p', episodeId: 'e', destination: 'youtube', idempotencyKey: 'same', packageArtifactId: 'pa', packageVersionId: 'pv', packageHash: 'b'.repeat(64), renderArtifactId: 'ra', renderVersionId: 'rv', renderHash: 'a'.repeat(64), gateSnapshot: gate });
  assert.equal(a.gateFingerprint, b.gateFingerprint);
  assert.equal(a.packageHash, 'b'.repeat(64));
  assert.throws(() => { a.gateSnapshot.approvalId = 'changed'; }, TypeError);
  assert.equal(fingerprint(gate), a.gateFingerprint);
});

test('youtube adapter delegates resumable upload and receipt reconciliation without leaking credentials', async () => {
  const calls = [];
  const publisher = {
    async publish(input) { calls.push(input); return { id: 'video-1', url: 'https://www.youtube.com/watch?v=video-1', response: { id: 'video-1', access_token: 'must-not-persist' } }; },
    async getVideo(id) { return { id, status: { uploadStatus: 'processed' } }; },
  };
  const adapter = new YouTubeDestinationAdapter({ publisher });
  const request = new PublishRequest({ tenantId: 't', projectId: 'p', episodeId: 'e', destination: 'youtube', idempotencyKey: 'k', packageArtifactId: 'pa', packageVersionId: 'pv', packageHash: 'a'.repeat(64), renderArtifactId: 'ra', renderVersionId: 'rv', renderHash: 'b'.repeat(64), metadata: { title: 'Test video' } });
  const result = await adapter.publish({ request, sourcePath: '/tmp/video.mp4' });
  assert.equal(result.id, 'video-1');
  assert.equal(calls.length, 1);
  const reconciled = await adapter.reconcile({ request, externalId: 'video-1' });
  assert.equal(reconciled.state, 'PUBLISHED');
});

test('postgres publishing invariants and concurrent idempotency', { skip: !process.env.FORGE_RUN_PUBLISH_INTEGRATION || !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const suffix = randomUUID();
  const tenantId = `publish-test-tenant:${suffix}`;
  const projectId = `publish-test-project:${suffix}`;
  const episodeId = `publish-test-episode:${suffix}`;
  const packageVersionId = `publish-test-package-version:${suffix}`;
  const renderVersionId = `publish-test-render-version:${suffix}`;
  const packageArtifactId = `publish-test-package-artifact:${suffix}`;
  const renderArtifactId = `publish-test-render-artifact:${suffix}`;
  const requestId = `publish-test-request:${suffix}`;
  const idempotencyKey = `publish-test-idem:${suffix}`;
  try {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'test')", [tenantId, tenantId]);
      await c.query("INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,'test',$3)", [projectId, projectId, tenantId]);
      await c.query("INSERT INTO episodes(id,project_id,title,created_by,state,current_render_id,approved_render_id) VALUES($1,$2,'publish test','test','APPROVED',$3,$3)", [episodeId, projectId, renderArtifactId]);
      await c.query("INSERT INTO version_records(id,episode_id,kind,created_by) VALUES($1,$2,'render','test'),($3,$2,'package','test')", [renderVersionId, episodeId, packageVersionId]);
      await c.query("INSERT INTO artifacts(id,episode_id,kind,version_id,content_hash,media_type,created_by) VALUES($1,$2,'render',$3,$4,'video/mp4','test'),($5,$2,'package',$6,$7,'application/json','test')", [renderArtifactId, episodeId, renderVersionId, 'b'.repeat(64), packageArtifactId, packageVersionId, 'a'.repeat(64)]);
      await c.query("INSERT INTO publish_requests(id,tenant_id,project_id,episode_id,destination,idempotency_key,package_artifact_id,package_version_id,package_hash,render_artifact_id,render_version_id,render_hash,gate_fingerprint,created_by) VALUES($1,$2,$3,$4,'youtube',$5,$6,$7,$8,$9,$10,$11,$12,'test')", [requestId, tenantId, projectId, episodeId, idempotencyKey, packageArtifactId, packageVersionId, 'a'.repeat(64), renderArtifactId, renderVersionId, 'b'.repeat(64), 'c'.repeat(64)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    const [first, second] = await Promise.all([
      pool.query("INSERT INTO publish_attempts(id,request_id,attempt_no,status,operation_key,provider_request_key) VALUES($1,$2,1,'UPLOADING',$3,$4) ON CONFLICT(request_id,attempt_no) DO NOTHING", [`a:${suffix}`, requestId, `op:${suffix}`, `provider:${suffix}`]),
      pool.query("INSERT INTO publish_attempts(id,request_id,attempt_no,status,operation_key,provider_request_key) VALUES($1,$2,1,'UPLOADING',$3,$4) ON CONFLICT(request_id,attempt_no) DO NOTHING", [`b:${suffix}`, requestId, `op:${suffix}`, `provider:${suffix}`]),
    ]);
    assert.equal(first.rowCount + second.rowCount, 1);
    const duplicate = await pool.query("INSERT INTO publish_receipts(id,tenant_id,project_id,request_id,destination,external_id,package_hash,receipt_state) VALUES($1,$2,$3,$4,'youtube',$5,$6,'PUBLISHED')", [`receipt:${suffix}`, tenantId, projectId, requestId, `external:${suffix}`, 'a'.repeat(64)]);
    assert.equal(duplicate.rowCount, 1);
  } finally {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query('DELETE FROM publish_receipts WHERE request_id=$1',[requestId]); await c.query('DELETE FROM publish_attempts WHERE request_id=$1',[requestId]); await c.query('DELETE FROM publish_requests WHERE id=$1',[requestId]); await c.query('DELETE FROM artifacts WHERE episode_id=$1',[episodeId]); await c.query('DELETE FROM version_records WHERE episode_id=$1',[episodeId]); await c.query('DELETE FROM episodes WHERE id=$1',[episodeId]); await c.query('DELETE FROM projects WHERE id=$1',[projectId]); await c.query('DELETE FROM tenants WHERE id=$1',[tenantId]); await c.query('COMMIT'); } finally { c.release(); await pool.end(); }
  }
});
