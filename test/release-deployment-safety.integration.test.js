'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { ReleaseSafetyService } = require('../src/release-safety/release-safety');
const { runSafeMigrations } = require('../src/release-safety/migration-runner');

const hasDatabase = Boolean(process.env.DATABASE_URL);
const migrationsDir = path.join(__dirname, '..', 'migrations');

test('release deployment safety is fail-closed for competing releases and worker versions', { skip: !hasDatabase }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const releaseId = `test-release-${randomUUID()}`;
  const competingId = `test-release-${randomUUID()}`;
  const workerId = `test-worker-${randomUUID()}`;
  try {
    await runSafeMigrations({ pool, migrationsDir, actor: 'release-safety-integration' });
    const service = new ReleaseSafetyService({ pool, migrationsDir });

    const manifest = {
      releaseId,
      commitSha: 'a'.repeat(40),
      appVersion: '1.0.0',
      schemaVersion: '013',
      minSchemaVersion: '013',
      maxSchemaVersion: '013',
      requiredIndexes: ['forge_release_manifests_status_idx', 'forge_worker_fences_release_idx'],
      requiredConfig: {},
      workerContracts: { payloadVersion: 'forge-job-v1' },
      rollbackPolicy: { mode: 'CLASSIFY', requiresForwardSchema: true },
    };

    await service.saveManifest(manifest, 'integration');
    const approval = await service.approve(releaseId, 'integration', { reason: 'integration-test' });
    assert.equal(approval.decision, 'APPROVED');
    await service.activate(releaseId, 'integration');

    const competing = { ...manifest, releaseId: competingId, commitSha: 'b'.repeat(40) };
    await service.saveManifest(competing, 'integration');
    await service.approve(competingId, 'integration');
    await assert.rejects(
      service.activate(competingId, 'integration'),
      (error) => error.code === 'RELEASE_DEPLOY_IN_PROGRESS',
    );

    const stale = await service.workerAdmission({
      workerId,
      releaseId: 'old-release',
      appVersion: '0.9.0',
      schemaVersion: '012',
    });
    assert.equal(stale.allowed, false);

    const current = await service.workerAdmission({
      workerId: `current-${workerId}`,
      releaseId,
      appVersion: '1.0.0',
      schemaVersion: '013',
    });
    assert.equal(current.allowed, true);

    const flagError = await service.setFlag(
      'unsafe_flag',
      { enabled: true, rolloutPercent: 10, safeForRollback: false },
      'integration',
    ).then(() => null, (error) => error);
    assert.equal(flagError.code, 'UNSAFE_FLAG_ROLLOUT');

    const postDeploy = await service.postDeploy(releaseId);
    assert.equal(postDeploy.ok, true);
  } finally {
    await pool.query('DELETE FROM forge_worker_fences WHERE worker_id LIKE $1', [`%${workerId}%`]).catch(() => {});
    await pool.query('DELETE FROM forge_release_checkpoints WHERE release_id = ANY($1::text[])', [[releaseId, competingId]]).catch(() => {});
    await pool.query('DELETE FROM forge_release_approvals WHERE release_id = ANY($1::text[])', [[releaseId, competingId]]).catch(() => {});
    await pool.query('DELETE FROM forge_schema_drift_snapshots WHERE release_id = ANY($1::text[])', [[releaseId, competingId]]).catch(() => {});
    await pool.query('DELETE FROM forge_release_manifests WHERE release_id = ANY($1::text[])', [[releaseId, competingId]]).catch(() => {});
    await pool.query("UPDATE forge_release_state SET previous_release_id=NULL,active_release_id=NULL,state='IDLE',updated_at=now() WHERE id=true").catch(() => {});
    await pool.end();
  }
});
