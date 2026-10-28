'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('publish dispatch fence allows one unchanged release identity and rejects stale fingerprints', { skip: !process.env.FORGE_RUN_PUBLISH_INTEGRATION || !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const suffix = randomUUID();
  const ids = {
    tenant: `dispatch-fence-tenant:${suffix}`,
    project: `dispatch-fence-project:${suffix}`,
    episode: `dispatch-fence-episode:${suffix}`,
    renderVersion: `dispatch-fence-render-version:${suffix}`,
    packageVersion: `dispatch-fence-package-version:${suffix}`,
    renderArtifact: `dispatch-fence-render-artifact:${suffix}`,
    packageArtifact: `dispatch-fence-package-artifact:${suffix}`,
    requestA: `dispatch-fence-request-a:${suffix}`,
    requestB: `dispatch-fence-request-b:${suffix}`,
    requestChanged: `dispatch-fence-request-changed:${suffix}`,
  };
  const packageHash = 'a'.repeat(64);
  const renderHash = 'b'.repeat(64);
  const fingerprint = 'c'.repeat(64);
  const changedFingerprint = 'd'.repeat(64);
  const requestIdentityValues = [ids.tenant, ids.project, ids.episode, ids.packageArtifact, ids.packageVersion, packageHash, ids.renderArtifact, ids.renderVersion, renderHash];

  try {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$1,'test')", [ids.tenant]);
      await c.query("INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$1,'test',$2)", [ids.project, ids.tenant]);
      await c.query("INSERT INTO episodes(id,project_id,title,created_by,state,current_render_id,approved_render_id) VALUES($1,$2,'dispatch fence','test','APPROVED',$3,$3)", [ids.episode, ids.project, ids.renderArtifact]);
      await c.query("INSERT INTO version_records(id,episode_id,kind,created_by) VALUES($1,$2,'render','test'),($3,$2,'package','test')", [ids.renderVersion, ids.episode, ids.packageVersion]);
      await c.query("INSERT INTO artifacts(id,episode_id,kind,version_id,content_hash,media_type,created_by) VALUES($1,$2,'render',$3,$4,'video/mp4','test'),($5,$2,'package',$6,$7,'application/json','test')", [ids.renderArtifact, ids.episode, ids.renderVersion, renderHash, ids.packageArtifact, ids.packageVersion, packageHash]);
      await c.query("INSERT INTO publish_requests(id,tenant_id,project_id,episode_id,destination,idempotency_key,package_artifact_id,package_version_id,package_hash,render_artifact_id,render_version_id,render_hash,gate_fingerprint,created_by,created_at) VALUES($1,$2,$3,$4,'youtube',$5,$6,$7,$8,$9,$10,$11,$12,'test',clock_timestamp())", [ids.requestA, ...requestIdentityValues, `idem-a:${suffix}`, fingerprint]);
      await c.query("INSERT INTO publish_requests(id,tenant_id,project_id,episode_id,destination,idempotency_key,package_artifact_id,package_version_id,package_hash,render_artifact_id,render_version_id,render_hash,gate_fingerprint,created_by,created_at) VALUES($1,$2,$3,$4,'youtube',$5,$6,$7,$8,$9,$10,$11,$12,'test',clock_timestamp())", [ids.requestB, ...requestIdentityValues, `idem-b:${suffix}`, fingerprint]);
      await c.query("INSERT INTO publish_requests(id,tenant_id,project_id,episode_id,destination,idempotency_key,package_artifact_id,package_version_id,package_hash,render_artifact_id,render_version_id,render_hash,gate_fingerprint,created_by,created_at) VALUES($1,$2,$3,$4,'youtube',$5,$6,$7,$8,$9,$10,$11,$12,'test',clock_timestamp()+interval '1 second')", [ids.requestChanged, ...requestIdentityValues, `idem-changed:${suffix}`, changedFingerprint]);
      await c.query('COMMIT');
    } finally { c.release(); }

    const attemptInsert = (attemptId, requestId) => pool.query(
      "INSERT INTO publish_attempts(id,request_id,attempt_no,status,operation_key,provider_request_key) VALUES($1,$2,1,'UPLOADING',$3,$4)",
      [attemptId, requestId, `operation:${attemptId}`, `provider:${attemptId}`],
    );

    const results = await Promise.allSettled([
      attemptInsert(`attempt-a:${suffix}`, ids.requestA),
      attemptInsert(`attempt-b:${suffix}`, ids.requestB),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejected = results.find((result) => result.status === 'rejected').reason;
    assert.equal(rejected.code, '23505');

    const persisted = await pool.query("SELECT count(*)::int AS count, count(dispatch_fingerprint)::int AS fenced FROM publish_attempts WHERE request_id = ANY($1::text[])", [[ids.requestA, ids.requestB]]);
    assert.deepEqual(persisted.rows[0], { count: 1, fenced: 1 });

    await assert.rejects(
      () => attemptInsert(`attempt-stale:${suffix}`, ids.requestA),
      (error) => error.code === 'P0001' && /gate fingerprint is stale/.test(error.message),
    );

    const changed = await attemptInsert(`attempt-changed:${suffix}`, ids.requestChanged);
    assert.equal(changed.rowCount, 1);
    const releaseAttempts = await pool.query("SELECT request_id, dispatch_fingerprint, status FROM publish_attempts WHERE request_id = ANY($1::text[]) ORDER BY request_id", [[ids.requestA, ids.requestB, ids.requestChanged]]);
    assert.equal(releaseAttempts.rows.length, 2);
    assert.notEqual(releaseAttempts.rows[0].dispatch_fingerprint, releaseAttempts.rows[1].dispatch_fingerprint);
  } finally {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM publish_attempts WHERE request_id = ANY($1::text[])', [[ids.requestA, ids.requestB, ids.requestChanged]]);
      await c.query('DELETE FROM publish_requests WHERE id = ANY($1::text[])', [[ids.requestA, ids.requestB, ids.requestChanged]]);
      await c.query('DELETE FROM artifacts WHERE episode_id=$1', [ids.episode]);
      await c.query('DELETE FROM version_records WHERE episode_id=$1', [ids.episode]);
      await c.query('DELETE FROM episodes WHERE id=$1', [ids.episode]);
      await c.query('DELETE FROM projects WHERE id=$1', [ids.project]);
      await c.query('DELETE FROM tenants WHERE id=$1', [ids.tenant]);
      await c.query('COMMIT');
    } finally { c.release(); await pool.end(); }
  }
});
