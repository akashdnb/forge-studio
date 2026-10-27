'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { createStorageFromEnv } = require('../storage');
const { createDefaultDestinationRegistry } = require('./destination-contract');
const { PublishService } = require('./publish-service');

function createPublishingHandlers({ pool, storage = null, publisher = null, logger = console, now = () => new Date(), observability = null, registry = null } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  const backend = storage || createStorageFromEnv();
  if (!backend || typeof backend.download !== 'function') throw new TypeError('storage backend is required');
  const destinationRegistry = registry || createDefaultDestinationRegistry({ pool, publisher, logger });
  const service = new PublishService({ pool, storage: backend, registry: destinationRegistry, logger, now, observability });
  const publish = async (payload, job = {}) => withPublishLease({ pool, service, runId: payload?.publishRunId, job, now, logger }, () => service.publish({ runId: payload?.publishRunId, job, actor: payload?.actor || job.actor || 'worker' }));
  return {
    'publish:youtube': publish,
    'publish:destination': publish,
    'publish:reconcile': async (payload, job = {}) => service.reconcile(payload?.publishRunId, payload?.actor || job.actor || 'operator'),
    'publish:retry': async (payload, job = {}) => service.retry(payload?.publishRunId, payload?.actor || job.actor || 'operator'),
    'publish:cancel': async (payload, job = {}) => service.cancel(payload?.publishRunId, payload?.actor || job.actor || 'operator', payload?.reason || 'operator cancellation'),
    'publish:quarantine': async (payload, job = {}) => service.quarantine(payload?.publishRunId, payload?.actor || job.actor || 'operator', payload?.reason || 'operator quarantine'),
  };
}

async function withPublishLease({ pool, runId, job, now, logger }, operation) {
  if (!runId) throw Object.assign(new Error('publishRunId is required'), { retryable: false, code: 'INVALID_JOB' });
  const leaseToken = randomUUID();
  const claimed = await pool.query(`UPDATE publish_runs SET lease_token=$2,lease_until=$3+interval '30 minutes' WHERE id=$1 AND status IN ('QUEUED','UPLOADING') AND (lease_token IS NULL OR lease_until IS NULL OR lease_until<$3) RETURNING id`, [runId, leaseToken, now()]);
  if (!claimed.rows[0]) {
    await pool.query(`INSERT INTO forge_concurrency_events(event_type,episode_id,actor,details) SELECT 'PUBLISH_RACE',episode_id,$2,$3::jsonb FROM publish_runs WHERE id=$1`, [runId, job.worker_id || 'worker', JSON.stringify({ publishRunId: runId })]).catch(() => {});
    throw Object.assign(new Error('Publish run is already owned by another worker'), { retryable: true, code: 'PUBLISH_RACE' });
  }
  let renewal = setInterval(() => pool.query(`UPDATE publish_runs SET lease_until=now()+interval '30 minutes' WHERE id=$1 AND lease_token=$2 AND status='UPLOADING'`, [runId, leaseToken]).catch(() => {}), 30000);
  renewal.unref?.();
  try {
    const result = await operation();
    const verified = await pool.query(`SELECT status,lease_token FROM publish_runs WHERE id=$1`, [runId]);
    if (verified.rows[0]?.status === 'PUBLISHED' && verified.rows[0]?.lease_token !== leaseToken) throw Object.assign(new Error('Publish run lease was lost after provider success'), { retryable: false, code: 'PUBLISH_RACE', terminalState: 'RECONCILIATION_REQUIRED' });
    return result;
  } catch (error) {
    logger.warn?.({ event: 'publish.lease_operation_failed', runId, code: error.code, message: error.message });
    throw error;
  } finally {
    clearInterval(renewal);
    await pool.query(`UPDATE publish_runs SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [runId, leaseToken]).catch(() => {});
  }
}

function assertReleaseGate(run) {
  if (run.destination !== 'youtube') throw Object.assign(new Error(`Unsupported publish destination: ${run.destination}`), { retryable: false, code: 'INVALID_DESTINATION' });
  if (!['APPROVED', 'PUBLISHING'].includes(run.episode_state)) throw Object.assign(new Error('Episode is not approved for publication'), { retryable: false, code: 'RELEASE_GATE_BLOCKED' });
  if (run.approved_render_id !== run.render_artifact_id || run.current_render_id !== run.render_artifact_id) throw Object.assign(new Error('Publish render is stale or no longer the selected approved render'), { retryable: false, code: 'STALE_ARTIFACT' });
  if (run.artifact_kind !== 'render' || run.artifact_version_id !== run.render_version_id) throw Object.assign(new Error('Publish artifact/version provenance mismatch'), { retryable: false, code: 'INVALID_PROVENANCE' });
  if (!run.content_hash || !/^[a-f0-9]{64}$/.test(run.content_hash)) throw Object.assign(new Error('Approved render has no trusted checksum'), { retryable: false, code: 'INVALID_PROVENANCE' });
  if (run.storage_hash && run.storage_hash !== run.content_hash) throw Object.assign(new Error('Stored render checksum metadata does not match artifact checksum'), { retryable: false, code: 'CHECKSUM_MISMATCH' });
  if (!run.storage_key || run.storage_status !== 'READY') throw Object.assign(new Error('Approved render storage is not ready'), { retryable: false, code: 'ARTIFACT_UNAVAILABLE' });
  if (run.media_type !== 'video/mp4') throw Object.assign(new Error('Only an MP4 render can be published'), { retryable: false, code: 'INVALID_MEDIA_TYPE' });
  if (!['PASSED', 'WARNINGS'].includes(run.qa_status)) throw Object.assign(new Error('Latest QA result is not passing'), { retryable: false, code: 'QA_BLOCKED' });
  if (run.approval_decision !== 'APPROVED' || run.approval_target_id !== run.render_artifact_id || run.approval_version_id !== run.render_version_id) throw Object.assign(new Error('Final render approval does not match the publish artifact'), { retryable: false, code: 'APPROVAL_BLOCKED' });
  return true;
}

async function materializeTrustedArtifact({ storage, run }) {
  const temp = path.join(os.tmpdir(), `forge-publish-${run.id}-${Math.random().toString(16).slice(2)}.mp4`);
  try {
    const resolved = await storage.download({ key: run.storage_key, expectedSha256: run.content_hash });
    await pipeline(resolved.stream, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const stat = await fsp.stat(temp);
    if (!stat.size) throw Object.assign(new Error('Approved render is empty'), { retryable: false, code: 'INVALID_ARTIFACT' });
    return { path: temp, size: stat.size };
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw Object.assign(error, { retryable: false });
  }
}

module.exports = { createPublishingHandlers, assertReleaseGate, materializeTrustedArtifact, withPublishLease };
