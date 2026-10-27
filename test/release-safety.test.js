const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeMigration, inspectMigrations, canonicalManifest, classifyRollback, compareVersions, sanitize } = require('../src/release-safety/release-safety');
const migrationsDir = path.join(__dirname, '..', 'migrations');

test('migration audit detects destructive SQL and requires an explicit override', () => {
  const unsafe = analyzeMigration('014_bad.sql', 'ALTER TABLE episodes DROP COLUMN title;');
  assert.equal(unsafe.unsafe, true);
  const allowed = analyzeMigration('014_allowed.sql', '-- forge:allow-destructive reason=contracted\nALTER TABLE episodes DROP COLUMN title;');
  assert.equal(allowed.unsafe, false);
});

test('migration audit preserves and reports legacy duplicate prefixes', async () => {
  const audit = await inspectMigrations(migrationsDir);
  const seven = audit.duplicateNumbers.find((item) => item.number === 7);
  assert.ok(seven);
  assert.ok(seven.names.length >= 2);
  assert.equal(audit.invalidOrder, false);
});

test('manifest hashing is deterministic and secret-free', () => {
  const input = { releaseId:'r1', commitSha:'abc', appVersion:'1.0.0', schemaVersion:'013', requiredConfig:{DATABASE_URL:true,API_TOKEN:true}, secret:'do-not-store' };
  const a = canonicalManifest(input), b = canonicalManifest(input);
  assert.equal(a.manifestHash, b.manifestHash);
  assert.equal(a.secret, undefined);
  assert.equal(a.requiredConfig.API_TOKEN, '[REDACTED]');
  assert.ok(!JSON.stringify(a).includes('do-not-store'));
});

test('version comparison orders compatible schema versions', () => {
  assert.equal(compareVersions('1.2.0','1.3.0') < 0, true);
  assert.equal(compareVersions('2.0.0','1.9.9') > 0, true);
});

test('rollback classification requires roll-forward after irreversible state', () => {
  const manifest = canonicalManifest({ releaseId:'r', commitSha:'c', appVersion:'1.0.0', schemaVersion:'013', rollbackPolicy:{ requiresForwardSchema:true } });
  assert.equal(classifyRollback({ migrationPreflightResult:{ applied:[{version:'008'}], audit:{items:[{name:'008',destructive:true}]} }, manifest }).classification, 'ROLL_FORWARD_REQUIRED');
  assert.equal(classifyRollback({ migrationPreflightResult:{ applied:[] }, manifest, schemaChanged:false }).classification, 'SAFE_ROLLBACK');
});

test('sanitizer redacts secret values and preserves release evidence shape', () => {
  const evidence = sanitize({ token:'abc', nested:{password:'secret', ok:'yes'}, commit:'abc' });
  assert.equal(evidence.token, '[REDACTED]');
  assert.equal(evidence.nested.password, '[REDACTED]');
  assert.equal(evidence.nested.ok, 'yes');
});

test('postgres release safety integration covers approval, fencing and post-deploy drift evidence when TEST_DATABASE_URL is supplied', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const { runSafeMigrations } = require('../src/release-safety/migration-runner');
  const { ReleaseSafetyService } = require('../src/release-safety/release-safety');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  try {
    await runSafeMigrations({ pool, migrationsDir, actor:'release-safety-test' });
    const service = new ReleaseSafetyService({ pool, migrationsDir });
    const manifest = { releaseId:'test-release-a', commitSha:'test', appVersion:'1.0.0', schemaVersion:'013', minSchemaVersion:'013', maxSchemaVersion:'013', requiredIndexes:['forge_release_manifests_status_idx'] };
    await service.saveManifest(manifest, 'test');
    const approval = await service.approve('test-release-a','test',{reason:'integration-test'});
    assert.equal(approval.decision, 'APPROVED');
    await service.activate('test-release-a','test');
    const oldWorker = await service.workerAdmission({ workerId:'stale-worker', releaseId:'old-release', appVersion:'0.9.0', schemaVersion:'012' });
    assert.equal(oldWorker.allowed, false);
    const currentWorker = await service.workerAdmission({ workerId:'current-worker', releaseId:'test-release-a', appVersion:'1.0.0', schemaVersion:'013' });
    assert.equal(currentWorker.allowed, true);
    const flagError = await service.setFlag('unsafe_flag', { enabled:true, rolloutPercent:10, safeForRollback:false }, 'test').then(()=>null, e=>e);
    assert.equal(flagError.code, 'UNSAFE_FLAG_ROLLOUT');
    const post = await service.postDeploy('test-release-a');
    assert.equal(post.ok, true);
    const snapshots = await pool.query('SELECT release_id FROM forge_schema_drift_snapshots WHERE release_id=$1',[manifest.releaseId]);
    assert.equal(snapshots.rowCount, 1);
  } finally { await pool.end(); }
});
