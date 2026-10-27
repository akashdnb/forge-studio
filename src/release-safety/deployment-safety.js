'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { migrationPreflight, schemaSnapshot, canonicalManifest, compareVersions } = require('./release-safety');

const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safe = value => {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|credential|private.?key|authorization/i.test(k) ? '[REDACTED]' : safe(v)]));
  return value;
};
function readJson(value, fallback = {}) { if (!value) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }

class DeploymentSafetyService {
  constructor({ pool, migrationsDir = path.join(__dirname, '..', '..', 'migrations'), logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool; this.migrationsDir = migrationsDir; this.logger = logger;
  }

  async buildManifest(input = {}) {
    if (!input.releaseId || !input.commitSha || !input.appVersion) throw Object.assign(new Error('releaseId, commitSha and appVersion are required'), { code: 'RELEASE_MANIFEST_INVALID' });
    const migration = await migrationPreflight({ pool: this.pool, migrationsDir: this.migrationsDir });
    const schema = await schemaSnapshot(this.pool);
    const migrations = migration.audit.items.map(m => ({ name: m.name, checksum: m.checksum, number: Number(String(m.name).split('_', 1)[0]), unsafe: Boolean(m.unsafe), destructive: Boolean(m.destructive) }));
    const manifest = canonicalManifest({ ...input,
      migrationManifest: migrations,
      workerVersions: input.workerVersions || {},
      protocolVersions: input.protocolVersions || { publicRunner: 'forge-public-runner-v1', callbacks: '1' },
      requiredProtocolVersion: input.requiredProtocolVersion || '1',
      configSnapshotHash: input.configSnapshotHash || null,
      rolloutPolicy: input.rolloutPolicy || { allowPreviousEpoch: false, maxUnavailableWorkers: 0, requireDrainForUnsafeMigration: true },
      healthPolicy: input.healthPolicy || { requireSchemaMatch: true, requireWorkerAdmission: true, maxStaleRunnerExecutions: 0 },
      schemaVersion: input.schemaVersion || String(migrations.at(-1)?.number || 0),
      minSchemaVersion: input.minSchemaVersion || input.schemaVersion || String(migrations.at(-1)?.number || 0),
      maxSchemaVersion: input.maxSchemaVersion || input.schemaVersion || String(migrations.at(-1)?.number || 0),
      compatibilityWindow: input.compatibilityWindow || { allowPreviousEpoch: false, minWorkerVersion: input.appVersion, maxWorkerVersion: input.appVersion },
    });
    manifest.schemaSnapshotHash = schema.hash;
    manifest.migrationSetHash = sha256(migrations);
    manifest.manifestHash = sha256(safe(manifest));
    return manifest;
  }

  async recordCheck(releaseId, checkKey, phase, status, evidence = {}, attempt = 1) {
    const hash = sha256({ releaseId, checkKey, phase, status, evidence, attempt });
    const result = await this.pool.query(`INSERT INTO forge_release_deployment_checks(release_id,check_key,phase,status,evidence,check_hash,attempt) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(release_id,check_key,attempt) DO UPDATE SET status=EXCLUDED.status,evidence=EXCLUDED.evidence,check_hash=EXCLUDED.check_hash,updated_at=now() RETURNING *`, [releaseId, checkKey, phase, status, JSON.stringify(safe(evidence)), hash, attempt]);
    return result.rows[0];
  }

  async audit(releaseId, actor, action, fromState, toState, evidence = {}) {
    await this.pool.query('INSERT INTO forge_release_audit(release_id,actor,action,from_state,to_state,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [releaseId, actor || 'system', action, fromState || null, toState || null, JSON.stringify(safe(evidence))]);
  }

  async persistManifest(manifest, actor = 'system') {
    const m = await this.buildManifest(manifest);
    await this.pool.query(`INSERT INTO forge_release_manifests(id,release_id,commit_sha,manifest_hash,app_version,schema_version,min_schema_version,max_schema_version,compatibility_window,required_config,required_indexes,feature_flags,worker_contracts,dependency_requirements,rollback_policy,created_by,migration_manifest,worker_versions,protocol_versions,config_snapshot_hash,required_protocol_version,rollout_policy,health_policy) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21::jsonb,$22::jsonb) ON CONFLICT(release_id) DO UPDATE SET commit_sha=EXCLUDED.commit_sha,manifest_hash=EXCLUDED.manifest_hash,migration_manifest=EXCLUDED.migration_manifest,worker_versions=EXCLUDED.worker_versions,protocol_versions=EXCLUDED.protocol_versions,config_snapshot_hash=EXCLUDED.config_snapshot_hash,required_protocol_version=EXCLUDED.required_protocol_version,rollout_policy=EXCLUDED.rollout_policy,health_policy=EXCLUDED.health_policy,updated_at=now() RETURNING *`, [m.releaseId,m.commitSha,m.manifestHash,m.appVersion,m.schemaVersion,m.minSchemaVersion,m.maxSchemaVersion,JSON.stringify(m.compatibilityWindow),JSON.stringify(m.requiredConfig || {}),JSON.stringify(m.requiredIndexes || []),JSON.stringify(m.featureFlags || {}),JSON.stringify(m.workerContracts || {}),JSON.stringify(m.dependencyRequirements || {}),JSON.stringify(m.rollbackPolicy || {}),actor,JSON.stringify(m.migrationManifest),JSON.stringify(m.workerVersions),JSON.stringify(m.protocolVersions),m.configSnapshotHash || null,m.requiredProtocolVersion,JSON.stringify(m.rolloutPolicy),JSON.stringify(m.healthPolicy)]);
    return m;
  }

  async preflight(releaseId, input = {}, actor = 'system') {
    const manifest = input.releaseId ? await this.persistManifest(input, actor) : (await this.pool.query('SELECT * FROM forge_release_manifests WHERE release_id=$1', [releaseId])).rows[0];
    if (!manifest) throw Object.assign(new Error('Release manifest not found'), { code: 'NOT_FOUND', statusCode: 404 });
    const migration = await migrationPreflight({ pool: this.pool, migrationsDir: this.migrationsDir });
    const schema = await schemaSnapshot(this.pool);
    const active = (await this.pool.query('SELECT * FROM forge_release_state WHERE id=true')).rows[0];
    const activeJobs = Number((await this.pool.query("SELECT count(*)::int AS count FROM forge_jobs WHERE status='RUNNING'")).rows[0]?.count || 0);
    const activeWorkers = (await this.pool.query("SELECT worker_id,release_id,app_version,schema_version,status,last_seen_at FROM forge_worker_fences WHERE status='ACTIVE' ORDER BY worker_id")).rows;
    const staleExecutions = Number((await this.pool.query("SELECT count(*)::int AS count FROM forge_execution_runs WHERE backend='public-github-actions' AND status IN ('DISPATCHING','QUEUED','IN_PROGRESS') AND manifest_expires_at <= now()")).rows[0]?.count || 0);
    const featureFlagViolations = (await this.pool.query(`SELECT flag FROM forge_feature_flag_rollouts WHERE enabled=true AND safe_for_rollback=false AND rollout_percent NOT IN (0,100)`)).rows.map(r => r.flag);
    const expectedMigrationNames = Array.isArray(readJson(manifest.migration_manifest, [])) ? readJson(manifest.migration_manifest, []).map(x => x.name) : [];
    const actualMigrationNames = migration.audit.items.map(x => x.name);
    const migrationSetMismatch = expectedMigrationNames.length > 0 && sha256(expectedMigrationNames) !== sha256(actualMigrationNames);
    const schemaMismatch = manifest.config_snapshot_hash && manifest.schema_snapshot_hash && manifest.schema_snapshot_hash !== schema.hash;
    const issues = [];
    if (!migration.ok) issues.push('MIGRATION_PREFLIGHT_FAILED');
    if (migrationSetMismatch) issues.push('MIGRATION_SET_DRIFT');
    if (schemaMismatch) issues.push('SCHEMA_DRIFT');
    if (compareVersions(manifest.min_schema_version, manifest.max_schema_version) > 0) issues.push('INVALID_SCHEMA_COMPATIBILITY_WINDOW');
    if (active?.state === 'ROLL_FORWARD_REQUIRED' || active?.state === 'ROLLBACK_INTERRUPTED') issues.push('RECOVERY_STATE_BLOCKED');
    if (staleExecutions > Number(readJson(manifest.health_policy).maxStaleRunnerExecutions || 0)) issues.push('STALE_PUBLIC_RUNNER_EXECUTIONS');
    if (featureFlagViolations.length) issues.push('UNSAFE_FEATURE_FLAG_ROLLOUT');
    const unsafe = (readJson(manifest.migration_manifest, [])).some(x => x.unsafe);
    if (unsafe && activeJobs > 0 && readJson(manifest.rollout_policy).requireDrainForUnsafeMigration !== false) issues.push('ACTIVE_WORKLOAD_BLOCKS_UNSAFE_MIGRATION');
    for (const worker of activeWorkers) {
      if (worker.schema_version && (compareVersions(worker.schema_version, manifest.min_schema_version) < 0 || compareVersions(worker.schema_version, manifest.max_schema_version) > 0)) issues.push(`INCOMPATIBLE_WORKER:${worker.worker_id}`);
    }
    const evidence = { migration, schemaHash: schema.hash, activeRelease: active?.active_release_id || null, activeEpoch: active?.epoch || 0, activeJobs, activeWorkers, staleExecutions, featureFlagViolations, migrationSetMismatch, issues };
    for (const [key, ok] of [['schema', !schemaMismatch], ['migrations', migration.ok && !migrationSetMismatch], ['workers', !issues.some(x => x.startsWith('INCOMPATIBLE_WORKER:'))], ['public-runner', staleExecutions <= Number(readJson(manifest.health_policy).maxStaleRunnerExecutions || 0)], ['flags', featureFlagViolations.length === 0]]) await this.recordCheck(manifest.release_id, key, 'PREFLIGHT', ok ? 'PASSED' : 'FAILED', evidence);
    await this.recordCheck(manifest.release_id, 'preflight', 'PREFLIGHT', issues.length ? 'BLOCKED' : 'PASSED', evidence);
    return { ok: issues.length === 0, releaseId: manifest.release_id, manifest, issues, evidence };
  }

  async approve(releaseId, actor, evidence = {}) {
    const preflight = await this.preflight(releaseId, {}, actor);
    if (!preflight.ok) throw Object.assign(new Error(`Release preflight failed: ${preflight.issues.join(',')}`), { code: 'RELEASE_BLOCKED', statusCode: 409, evidence: preflight });
    if (!evidence.qa || !evidence.health || !evidence.rollbackPlan) throw Object.assign(new Error('QA, health and rollback-plan evidence are required'), { code: 'RELEASE_EVIDENCE_REQUIRED', statusCode: 422 });
    const result = await this.pool.query("INSERT INTO forge_release_approvals(release_id,actor,decision,evidence) VALUES($1,$2,'APPROVED',$3::jsonb) RETURNING *", [releaseId, actor, JSON.stringify(safe(evidence))]);
    await this.pool.query("UPDATE forge_release_manifests SET status='PREFLIGHT_PASSED',updated_at=now() WHERE release_id=$1 AND status IN ('PLANNED','PREFLIGHT_PASSED')", [releaseId]);
    await this.audit(releaseId, actor, 'APPROVE', 'PLANNED', 'PREFLIGHT_PASSED', evidence);
    return result.rows[0];
  }

  async activate(releaseId, actor = 'system') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('forge-release-deployment'))");
      const state = (await client.query('SELECT * FROM forge_release_state WHERE id=true FOR UPDATE')).rows[0];
      const manifest = (await client.query('SELECT * FROM forge_release_manifests WHERE release_id=$1 FOR UPDATE', [releaseId])).rows[0];
      if (!manifest) throw Object.assign(new Error('Release manifest not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (!['PREFLIGHT_PASSED','DEPLOYING'].includes(manifest.status)) throw Object.assign(new Error(`Release is not approved: ${manifest.status}`), { code: 'RELEASE_BLOCKED', statusCode: 409 });
      if (state.state === 'DEPLOYING' && state.active_release_id !== releaseId) throw Object.assign(new Error('Another release is deploying'), { code: 'RELEASE_DEPLOY_IN_PROGRESS', statusCode: 409 });
      const approvals = Number((await client.query("SELECT count(*)::int AS count FROM forge_release_approvals WHERE release_id=$1 AND decision='APPROVED'", [releaseId])).rows[0]?.count || 0);
      if (!approvals) throw Object.assign(new Error('Release approval is required'), { code: 'RELEASE_APPROVAL_REQUIRED', statusCode: 409 });
      const old = state.active_release_id;
      const nextEpoch = Number(state.epoch || 0) + 1;
      await client.query("UPDATE forge_release_manifests SET status='DEPLOYING',updated_at=now() WHERE release_id=$1", [releaseId]);
      await client.query("UPDATE forge_release_state SET previous_release_id=active_release_id,active_release_id=$1,state='DEPLOYING',epoch=$2,updated_at=now() WHERE id=true", [releaseId, nextEpoch]);
      await client.query("UPDATE forge_worker_fences SET status='DRAINING' WHERE status='ACTIVE' AND release_id<>$1", [releaseId]);
      await client.query("UPDATE forge_execution_runs SET release_id=$1,release_epoch=$2 WHERE status IN ('DISPATCHING','QUEUED','IN_PROGRESS') AND release_id IS NULL", [releaseId, nextEpoch]);
      await client.query("INSERT INTO forge_release_checkpoints(release_id,phase,status,evidence) VALUES($1,'DEPLOY','STARTED',$2::jsonb)", [releaseId, JSON.stringify({ actor, previousReleaseId: old, epoch: nextEpoch })]);
      await client.query('COMMIT');
      await this.audit(releaseId, actor, 'ACTIVATE', state.state, 'DEPLOYING', { previousReleaseId: old, epoch: nextEpoch });
      return { releaseId, epoch: nextEpoch, previousReleaseId: old, state: 'DEPLOYING' };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async health(releaseId = null) {
    const state = (await this.pool.query('SELECT * FROM forge_release_state WHERE id=true')).rows[0];
    const id = releaseId || state?.active_release_id;
    if (!id) return { ok: false, code: 'NO_ACTIVE_RELEASE', state };
    const manifest = (await this.pool.query('SELECT * FROM forge_release_manifests WHERE release_id=$1', [id])).rows[0];
    const schema = await schemaSnapshot(this.pool);
    const workers = (await this.pool.query("SELECT worker_id,release_id,app_version,schema_version,status,last_seen_at FROM forge_worker_fences WHERE status='ACTIVE' ORDER BY worker_id")).rows;
    const stale = Number((await this.pool.query("SELECT count(*)::int AS count FROM forge_execution_runs WHERE release_id=$1 AND release_epoch=$2 AND status IN ('DISPATCHING','QUEUED','IN_PROGRESS') AND manifest_expires_at <= now()", [id, state.epoch])).rows[0]?.count || 0);
    const ok = Boolean(manifest && state.active_release_id === id && state.state === 'DEPLOYED' && (!manifest.schema_snapshot_hash || manifest.schema_snapshot_hash === schema.hash) && stale === 0 && workers.every(w => compareVersions(w.schema_version, manifest.min_schema_version) >= 0 && compareVersions(w.schema_version, manifest.max_schema_version) <= 0));
    return { ok, releaseId: id, epoch: state.epoch, state: state.state, schemaHash: schema.hash, expectedSchemaHash: manifest?.schema_snapshot_hash || null, workers, stalePublicRunnerExecutions: stale };
  }

  async completeHealth(releaseId, actor = 'system') {
    const result = await this.health(releaseId);
    await this.recordCheck(releaseId, 'post-deploy-health', 'HEALTH', result.ok ? 'PASSED' : 'FAILED', result);
    if (!result.ok) {
      await this.pool.query("UPDATE forge_release_manifests SET status='BLOCKED',updated_at=now() WHERE release_id=$1", [releaseId]);
      await this.pool.query("UPDATE forge_release_state SET state='ROLL_FORWARD_REQUIRED',updated_at=now() WHERE id=true AND active_release_id=$1", [releaseId]);
      await this.audit(releaseId, actor, 'HEALTH_FAILED', 'DEPLOYING', 'ROLL_FORWARD_REQUIRED', result);
      return result;
    }
    await this.pool.query("UPDATE forge_release_manifests SET status='DEPLOYED',updated_at=now() WHERE release_id=$1", [releaseId]);
    await this.pool.query("UPDATE forge_release_state SET state='DEPLOYED',updated_at=now() WHERE id=true AND active_release_id=$1", [releaseId]);
    await this.pool.query("INSERT INTO forge_release_checkpoints(release_id,phase,status,evidence) VALUES($1,'POST_DEPLOY','PASSED',$2::jsonb)", [releaseId, JSON.stringify(result)]);
    await this.audit(releaseId, actor, 'HEALTH_PASSED', 'DEPLOYING', 'DEPLOYED', result);
    return result;
  }

  async rollback(releaseId, actor = 'system', evidence = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('forge-release-deployment'))");
      const state = (await client.query('SELECT * FROM forge_release_state WHERE id=true FOR UPDATE')).rows[0];
      if (state.active_release_id !== releaseId) throw Object.assign(new Error('Release is not active'), { code: 'RELEASE_NOT_ACTIVE', statusCode: 409 });
      const target = state.previous_release_id ? (await client.query('SELECT * FROM forge_release_manifests WHERE release_id=$1', [state.previous_release_id])).rows[0] : null;
      if (!target) throw Object.assign(new Error('No previous release checkpoint is available'), { code: 'ROLL_FORWARD_REQUIRED', statusCode: 409 });
      const manifest = (await client.query('SELECT * FROM forge_release_manifests WHERE release_id=$1', [releaseId])).rows[0];
      const irreversible = (readJson(manifest?.rollback_policy).requiresForwardSchema === true) || (readJson(manifest?.migration_manifest, [])).some(x => x.destructive || x.unsafe);
      if (irreversible) throw Object.assign(new Error('Release requires roll-forward; immutable schema/provenance must not be rewritten'), { code: 'ROLL_FORWARD_REQUIRED', statusCode: 409 });
      const nextEpoch = Number(state.epoch || 0) + 1;
      await client.query("INSERT INTO forge_release_recovery_checkpoints(release_id,checkpoint_key,state,target_release_id,evidence) VALUES($1,'rollback-target','COMPLETED',$2,$3::jsonb) ON CONFLICT(release_id,checkpoint_key) DO UPDATE SET state='COMPLETED',target_release_id=EXCLUDED.target_release_id,evidence=EXCLUDED.evidence,updated_at=now()", [releaseId, state.previous_release_id, JSON.stringify(safe(evidence))]);
      await client.query("UPDATE forge_release_state SET active_release_id=$1,previous_release_id=$2,state='DEPLOYING',epoch=$3,updated_at=now() WHERE id=true", [target.release_id, releaseId, nextEpoch]);
      await client.query("UPDATE forge_release_manifests SET status='ROLLED_BACK',updated_at=now() WHERE release_id=$1", [releaseId]);
      await client.query("INSERT INTO forge_release_checkpoints(release_id,phase,status,evidence) VALUES($1,'ROLLBACK','STARTED',$2::jsonb)", [releaseId, JSON.stringify({ actor, targetReleaseId: target.release_id, epoch: nextEpoch })]);
      await client.query('COMMIT');
      await this.audit(releaseId, actor, 'ROLLBACK', 'DEPLOYING', 'DEPLOYING', { targetReleaseId: target.release_id, epoch: nextEpoch, evidence });
      return { ok: true, classification: 'SAFE_ROLLBACK', targetReleaseId: target.release_id, epoch: nextEpoch };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async diagnostics() {
    const state = (await this.pool.query('SELECT * FROM forge_release_state WHERE id=true')).rows[0];
    const releases = (await this.pool.query("SELECT release_id,status,app_version,schema_version,required_protocol_version,created_at,updated_at FROM forge_release_manifests ORDER BY created_at DESC LIMIT 10")).rows;
    const failedChecks = (await this.pool.query("SELECT release_id,check_key,phase,status,created_at FROM forge_release_deployment_checks WHERE status IN ('FAILED','BLOCKED') ORDER BY created_at DESC LIMIT 50")).rows;
    const activeJobs = Number((await this.pool.query("SELECT count(*)::int AS count FROM forge_jobs WHERE status='RUNNING'")).rows[0]?.count || 0);
    return { ok: !failedChecks.length && state?.state !== 'ROLL_FORWARD_REQUIRED' && state?.state !== 'ROLLBACK_INTERRUPTED', state, activeJobs, releases, failedChecks };
  }
}
module.exports = { DeploymentSafetyService, sha256 };
