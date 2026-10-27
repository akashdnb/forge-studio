'use strict';
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { validateRuntimeConfig, SecretCipher, RuntimePolicyStore, fingerprint } = require('./runtime-policy');
const { captureJobRuntimeSnapshot, assertJobRuntimeSnapshot } = require('./job-runtime-snapshot');
const { JobQueue } = require('../persistence/job-queue');
const validation = validateRuntimeConfig(process.env, { requirePersistence: true });
if (!validation.ok) throw Object.assign(new Error(`Runtime configuration invalid: ${JSON.stringify(validation.issues)}`), { code: 'INVALID_RUNTIME_CONFIG' });
if (!process.env.FORGE_SECRET_ENCRYPTION_KEY) throw Object.assign(new Error('FORGE_SECRET_ENCRYPTION_KEY is required for the production worker'), { code: 'MISSING_SECRET_ENCRYPTION_KEY' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
const secretCipher = new SecretCipher(process.env.FORGE_SECRET_ENCRYPTION_KEY);
const runtimePolicy = new RuntimePolicyStore({ pool, secretCipher });
const originalClaim = JobQueue.prototype.claim;
const originalClaimSpecific = JobQueue.prototype.claimSpecific;
async function admit(queue, job, actorId) {
  if (!job) return null;
  try {
    const result = await assertJobRuntimeSnapshot({ pool: queue.pool, policyStore: runtimePolicy, job, actorId });
    await pool.query('INSERT INTO runtime_worker_snapshots(worker_id,tenant_id,runtime_fingerprint,policy_versions,feature_flags) SELECT $1,p.tenant_id,$2,$3::jsonb,$4::jsonb FROM projects p WHERE p.id=$5', [actorId || 'unknown', result.snapshot.fingerprint, JSON.stringify(result.snapshot.policyVersions || []), JSON.stringify(result.snapshot.featureFlags || {}), job.project_id]);
    return job;
  } catch (error) {
    await queue.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=now(),updated_at=now(),error=$1::jsonb WHERE id=$2 AND status='RUNNING'`, [JSON.stringify({ code: error.code || 'RUNTIME_POLICY_BLOCKED', message: error.message }), job.id]);
    if (error.code === 'FEATURE_KILL_SWITCHED' || error.code === 'RUNTIME_POLICY_DISABLED') return null;
    throw error;
  }
}
JobQueue.prototype.claim = async function patchedClaim(options) { return admit(this, await originalClaim.call(this, options), options?.workerId); };
JobQueue.prototype.claimSpecific = async function patchedClaimSpecific(id, workerId, now) { return admit(this, await originalClaimSpecific.call(this, id, workerId, now), workerId); };
const { createWorker, loadHandlers } = require('../worker');
const worker = createWorker({ pool, handlers: loadHandlers({ pool }) });
async function start() {
  const readiness = await runtimePolicy.readiness({ requireEncryption: true });
  if (!readiness.ok) throw new Error(`Runtime readiness failed: ${JSON.stringify(readiness)}`);
  const safeEnv = Object.fromEntries(Object.keys(process.env).filter(k => !/(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|DATABASE_URL)/i.test(k)).sort().map(k => [k, process.env[k]]));
  await pool.query('INSERT INTO runtime_boot_snapshots(boot_id,service,environment,config_fingerprint,env_fingerprint,diagnostics) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), 'forge-studio-worker', process.env.NODE_ENV || 'development', fingerprint(validation.config), fingerprint(safeEnv), JSON.stringify({ validation, readiness })]);
  await worker.run();
}
async function shutdown() { await worker.stop(); await pool.end(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
start().catch(async error => { console.error('Forge runtime-managed worker failed:', error.message); await pool.end(); process.exit(1); });
