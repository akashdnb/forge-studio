const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { runSafeMigrations } = require('../src/release-safety/migration-runner');
const { LocalFileStorage } = require('../src/storage/local-file-storage');
const { ArtifactRetentionOptimizer } = require('../src/storage/artifact-retention-optimizer');

const enabled = process.env.FORGE_RUN_ARTIFACT_GC_INTEGRATION === 'true';

test('real PostgreSQL artifact dedup, reservations, reachability and compaction', { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-artifact-gc-'));
  const storage = new LocalFileStorage({ rootDir: storageDir, maxBytes: 16 * 1024 * 1024 });
  const suffix = `${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const tenantA = `tenant:gc:a:${suffix}`;
  const tenantB = `tenant:gc:b:${suffix}`;
  const projectA = `project:gc:a:${suffix}`;
  const projectB = `project:gc:b:${suffix}`;
  const episodeA = `episode:gc:a:${suffix}`;
  const episodeB = `episode:gc:b:${suffix}`;
  const versionA = `version:gc:a:${suffix}`;
  const versionB = `version:gc:b:${suffix}`;
  const artifactA = `artifact:gc:a:${suffix}`;
  const artifactB = `artifact:gc:b:${suffix}`;
  try {
    await runSafeMigrations({ pool, actor: 'artifact-gc-test' });
    await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3),($4,$5,$3)', [tenantA, 'GC A', 'test', tenantB, 'GC B']);
    await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4),($5,$6,$3,$7)', [projectA, 'Project A', 'test', tenantA, projectB, 'Project B', tenantB]);
    await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [episodeA, projectA, 'Episode A', 'test', episodeB, projectB, 'Episode B']);
    await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'episode','{}',$3,$4),($5,$6,'episode','{}',$7,$4)`, [versionA, episodeA, crypto.createHash('sha256').update(versionA).digest('hex'), 'test', versionB, episodeB, crypto.createHash('sha256').update(versionB).digest('hex')]);
    const content = Buffer.from('same immutable bytes');
    const storedA = await storage.upload({ stream: Readable.from(content), tenantId: tenantA, projectId: projectA, kind: 'video', contentType: 'video/mp4' });
    const storedB = await storage.upload({ stream: Readable.from(content), tenantId: tenantB, projectId: projectB, kind: 'video', contentType: 'video/mp4' });
    await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,created_by) VALUES($1,$2,'video',$3,$4,$5,'video/mp4','test'),($6,$7,'video',$8,$9,$5,'video/mp4','test')`, [artifactA, episodeA, versionA, storedA.uri, storedA.sha256, artifactB, episodeB, versionB, storedB.uri]);
    await pool.query(`INSERT INTO storage_objects(id,project_id,artifact_id,uri,storage_key,kind,content_hash,media_type,size_bytes,checksum_verified,status,metadata) VALUES($1,$2,$3,$4,$5,'video',$6,'video/mp4',$7,true,'READY','{}'),($8,$9,$10,$11,$12,'video',$6,'video/mp4',$7,true,'READY','{}')`, [crypto.randomUUID(), projectA, artifactA, storedA.uri, storedA.key, storedA.sha256, storedA.sizeBytes, crypto.randomUUID(), projectB, artifactB, storedB.uri, storedB.key]);
    const objects = await pool.query('SELECT tenant_id,sha256,ref_count FROM artifact_content_objects WHERE sha256=$1 ORDER BY tenant_id', [storedA.sha256]);
    assert.equal(objects.rows.length, 2);
    assert.deepEqual(objects.rows.map((row) => Number(row.ref_count)), [1, 1]);

    const optimizer = new ArtifactRetentionOptimizer({ pool, storage, policy: { minAgeMinutes: 0, requireOperatorApproval: true, scanLimit: 50 } });
    await assert.rejects(() => optimizer.registerUploadedObject({ tenantId: tenantA, projectId: projectA, artifactId: `artifact:bad:${suffix}`, versionId: versionA, sha256: storedA.sha256, sizeBytes: storedA.sizeBytes + 1, mediaType: 'video/mp4', kind: 'video', storageKey: storedA.key }), { code: 'CHECKSUM_METADATA_MISMATCH' });

    const orphanContent = Buffer.from('orphan bytes');
    const orphanStored = await storage.upload({ stream: Readable.from(orphanContent), tenantId: tenantA, projectId: projectA, kind: 'derivative:proxy', contentType: 'video/mp4' });
    const orphanObjectId = `orphan:${suffix}`;
    await pool.query(`INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status) VALUES($1,$2,$3,$4,'video/mp4','derivative:proxy',$5,true,'READY')`, [orphanObjectId, tenantA, orphanStored.sha256, orphanStored.sizeBytes, orphanStored.key]);
    const recoveryContent = await storage.upload({ stream: Readable.from(Buffer.from('recovery bytes')), tenantId: tenantA, projectId: projectA, kind: 'package', contentType: 'application/zip' });
    await pool.query(`INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,recovery_required) VALUES($1,$2,$3,$4,'application/zip','package',$5,true,'READY',true)`, [`recovery:${suffix}`, tenantA, recoveryContent.sha256, recoveryContent.sizeBytes, recoveryContent.key]);

    const plan = await optimizer.createPlan({ tenantId: tenantA, createdBy: 'operator', mode: 'ENFORCE', policy: { minAgeMinutes: 0 }, reason: 'integration' });
    assert.equal(plan.status, 'WAITING_APPROVAL');
    const planned = await optimizer.executePlan({ tenantId: tenantA, planId: plan.id }).catch((error) => error);
    assert.equal(planned.code, 'APPROVAL_REQUIRED');
    await optimizer.approvePlan({ tenantId: tenantA, planId: plan.id, actor: 'operator' });
    const scanned = await optimizer.executePlan({ tenantId: tenantA, planId: plan.id });
    assert.equal(scanned.status, 'COMPLETED');
    const item = await pool.query('SELECT decision,reason FROM artifact_gc_items WHERE plan_id=$1 AND object_id=$2', [plan.id, orphanObjectId]);
    assert.equal(item.rows[0].decision, 'QUARANTINE');

    // Reference race: a late reference must win over destructive compaction.
    const orphanRefArtifact = `artifact:late-ref:${suffix}`;
    await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,created_by) VALUES($1,$2,'video',$3,$4,$5,'video/mp4','test')`, [orphanRefArtifact, episodeA, versionA, orphanStored.uri, orphanStored.sha256]);
    await pool.query(`INSERT INTO artifact_content_refs(id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active) VALUES($1,$2,$3,$4,$5,'RECOVERY',$6,true)`, [crypto.randomUUID(), tenantA, projectA, orphanRefArtifact, orphanObjectId, versionA]);
    const compacted = await optimizer.compactApprovedPlan({ tenantId: tenantA, planId: plan.id, maxDeletes: 10 });
    assert.equal(compacted.deleted, 0);
    const orphanState = await pool.query('SELECT status,ref_count FROM artifact_content_objects WHERE id=$1', [orphanObjectId]);
    assert.equal(orphanState.rows[0].status, 'READY');
    assert.equal(Number(orphanState.rows[0].ref_count), 1);

    const reserveObject = await pool.query('SELECT id FROM artifact_content_objects WHERE tenant_id=$1 AND sha256=$2', [tenantA, storedA.sha256]);
    const [r1, r2] = await Promise.all([optimizer.reserve({ tenantId: tenantA, objectId: reserveObject.rows[0].id, purpose: 'race', idempotencyKey: `same:${suffix}` }), optimizer.reserve({ tenantId: tenantA, objectId: reserveObject.rows[0].id, purpose: 'race', idempotencyKey: `same:${suffix}` })]);
    assert.equal(r1.id, r2.id);
    const reservationState = await pool.query('SELECT reservation_count FROM artifact_content_objects WHERE id=$1', [reserveObject.rows[0].id]);
    assert.equal(Number(reservationState.rows[0].reservation_count), 1);
    await optimizer.releaseReservation({ tenantId: tenantA, reservationId: r1.id });
    const releasedState = await pool.query('SELECT reservation_count FROM artifact_content_objects WHERE id=$1', [reserveObject.rows[0].id]);
    assert.equal(Number(releasedState.rows[0].reservation_count), 0);

    // Tenant isolation: identical bytes never share a physical ledger object across tenants.
    const isolated = await pool.query('SELECT count(*)::int count FROM artifact_content_objects WHERE sha256=$1', [storedA.sha256]);
    assert.equal(isolated.rows[0].count, 2);
    const recoveryState = await pool.query('SELECT status FROM artifact_content_objects WHERE id=$1', [`recovery:${suffix}`]);
    assert.equal(recoveryState.rows[0].status, 'READY');
  } finally {
    await pool.query('DELETE FROM artifact_content_refs WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]).catch(() => {});
    await pool.query('DELETE FROM artifact_gc_items WHERE tenant_id=$1', [tenantA]).catch(() => {});
    await pool.query('DELETE FROM artifact_gc_plans WHERE tenant_id=$1', [tenantA]).catch(() => {});
    await pool.query('DELETE FROM artifact_content_objects WHERE tenant_id IN ($1,$2)', [tenantA, tenantB]).catch(() => {});
    await pool.query('DELETE FROM storage_objects WHERE project_id IN ($1,$2)', [projectA, projectB]).catch(() => {});
    await pool.query('DELETE FROM artifacts WHERE episode_id IN ($1,$2)', [episodeA, episodeB]).catch(() => {});
    await pool.query('DELETE FROM version_records WHERE episode_id IN ($1,$2)', [episodeA, episodeB]).catch(() => {});
    await pool.query('DELETE FROM episodes WHERE id IN ($1,$2)', [episodeA, episodeB]).catch(() => {});
    await pool.query('DELETE FROM projects WHERE id IN ($1,$2)', [projectA, projectB]).catch(() => {});
    await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)', [tenantA, tenantB]).catch(() => {});
    await pool.end(); await fs.rm(storageDir, { recursive: true, force: true });
  }
});
