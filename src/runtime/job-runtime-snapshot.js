'use strict';
const { fingerprint } = require('./runtime-policy');
async function captureJobRuntimeSnapshot({ pool, policyStore, job, actorId = null }) {
  if (!pool || !policyStore || !job) throw new TypeError('pool, policyStore and job are required');
  const existing = job.runtime_snapshot || (await pool.query('SELECT runtime_snapshot FROM forge_jobs WHERE id=$1', [job.id])).rows[0]?.runtime_snapshot;
  if (existing) return existing;
  const provider = job.payload?.provider || job.payload?.providerName || null;
  const scopedJob = provider ? { ...job, payload: { ...(job.payload || {}), provider: `${job.tenant_id || 'tenant'}:${provider}` } } : job;
  const snapshot = await policyStore.snapshotForJob({ job: scopedJob, actorId });
  const result = await pool.query(`UPDATE forge_jobs SET runtime_snapshot=$1::jsonb,runtime_snapshot_hash=$2,runtime_policy_versions=$3::jsonb,updated_at=now() WHERE id=$4 AND runtime_snapshot IS NULL RETURNING runtime_snapshot`, [JSON.stringify(snapshot), fingerprint(snapshot), JSON.stringify(snapshot.policyVersions), job.id]);
  return result.rows[0]?.runtime_snapshot || (await pool.query('SELECT runtime_snapshot FROM forge_jobs WHERE id=$1', [job.id])).rows[0]?.runtime_snapshot || snapshot;
}
async function assertJobRuntimeSnapshot({ pool, policyStore, job, actorId = null }) {
  const snapshot = await captureJobRuntimeSnapshot({ pool, policyStore, job, actorId });
  const provider = job.payload?.provider || job.payload?.providerName || null;
  const scopedJob = provider ? { ...job, payload: { ...(job.payload || {}), provider: `${job.tenant_id || 'tenant'}:${provider}` } } : job;
  const current = await policyStore.snapshotForJob({ job: scopedJob, actorId });
  for (const [key, state] of Object.entries(current.featureFlags || {})) {
    if (state.killSwitch && state.enabled === false) throw Object.assign(new Error(`Feature ${key} was disabled by kill switch`), { code: 'FEATURE_KILL_SWITCHED', retryable: false });
  }
  if (current.config?.execution?.enabled === false || (provider && current.config?.providers?.[`${job.tenant_id || 'tenant'}:${provider}`]?.enabled === false)) {
    throw Object.assign(new Error(`Execution is disabled by runtime policy for ${provider || 'job'}`), { code: 'RUNTIME_POLICY_DISABLED', retryable: false });
  }
  return { snapshot, current, provider };
}
module.exports = { captureJobRuntimeSnapshot, assertJobRuntimeSnapshot };
