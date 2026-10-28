'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimePublishService } = require('../src/publishing/publish-service-runtime');
const { fingerprint } = require('../src/publishing/destination-contract');

function service() {
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => {}, release() {} }) };
  return new RuntimePublishService({
    pool,
    storage: { download: async () => { throw new Error('not used'); } },
    registry: { get: () => ({}) },
    coordinator: { acquire: async () => ({ acquired: false }) }
  });
}

function run(overrides = {}) {
  return {
    id: 'publish-run-1',
    destination: 'youtube',
    episode_state: 'PUBLISHING',
    approved_render_id: 'render-1',
    current_render_id: 'render-1',
    render_artifact_id: 'render-1',
    render_version_id: 'render-v1',
    artifact_kind: 'render',
    artifact_version_id: 'render-v1',
    content_hash: 'a'.repeat(64),
    storage_hash: 'a'.repeat(64),
    storage_key: 'renders/render-1',
    storage_status: 'READY',
    media_type: 'video/mp4',
    qa_status: 'PASSED',
    qa_id: 'qa-1',
    approval_decision: 'APPROVED',
    approval_target_id: 'render-1',
    approval_version_id: 'render-v1',
    package_artifact_id: 'episode-package-1',
    package_version_id: 'package-v1',
    package_status: 'READY',
    package_hash: 'b'.repeat(64),
    delivery_package_id: 'delivery:youtube_long_form:1',
    delivery_profile_id: 'youtube_long_form',
    delivery_artifact_id: 'delivery-artifact-1',
    delivery_version_id: 'delivery-v1',
    delivery_content_hash: 'c'.repeat(64),
    delivery_package_status: 'READY',
    delivery_storage_status: 'READY',
    ...overrides
  };
}

test('publish gate fingerprint binds the exact delivery package/profile/artifact/version/hash', () => {
  const publisher = service();
  const first = publisher.gateSnapshot(run());
  const changedArtifact = publisher.gateSnapshot(run({ delivery_artifact_id: 'delivery-artifact-2', delivery_content_hash: 'd'.repeat(64) }));
  assert.equal(first.deliveryPackageId, 'delivery:youtube_long_form:1');
  assert.equal(first.deliveryProfileId, 'youtube_long_form');
  assert.notEqual(fingerprint(first), fingerprint(changedArtifact));
});

test('publish gate fails closed when delivery identity is incomplete', () => {
  const publisher = service();
  assert.throws(() => publisher.gate(run({ delivery_version_id: null })), (error) => error.code === 'DELIVERY_NOT_READY');
  assert.throws(() => publisher.gate(run({ delivery_content_hash: 'not-a-sha256' })), (error) => error.code === 'DELIVERY_NOT_READY');
  assert.throws(() => publisher.gate(run({ delivery_storage_status: 'MISSING' })), (error) => error.code === 'DELIVERY_NOT_READY');
});
