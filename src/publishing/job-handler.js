'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createStorageFromEnv } = require('../storage');
const { createDefaultDestinationRegistry } = require('./destination-contract');
const { PublishService } = require('./publish-service');

function createPublishingHandlers({ pool, storage = null, publisher = null, logger = console, now = () => new Date(), observability = null, registry = null } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  const backend = storage || createStorageFromEnv();
  if (!backend || typeof backend.download !== 'function') throw new TypeError('storage backend is required');
  const destinationRegistry = registry || createDefaultDestinationRegistry({ pool, publisher, logger });
  const service = new PublishService({ pool, storage: backend, registry: destinationRegistry, logger, now, observability });
  return {
    'publish:youtube': async (payload, job = {}) => service.publish({ runId: payload?.publishRunId, job, actor: payload?.actor || job.actor || 'worker' }),
    'publish:destination': async (payload, job = {}) => service.publish({ runId: payload?.publishRunId, job, actor: payload?.actor || job.actor || 'worker' }),
    'publish:reconcile': async (payload, job = {}) => service.reconcile(payload?.publishRunId, payload?.actor || job.actor || 'operator'),
    'publish:retry': async (payload, job = {}) => service.retry(payload?.publishRunId, payload?.actor || job.actor || 'operator'),
    'publish:cancel': async (payload, job = {}) => service.cancel(payload?.publishRunId, payload?.actor || job.actor || 'operator', payload?.reason || 'operator cancellation'),
    'publish:quarantine': async (payload, job = {}) => service.quarantine(payload?.publishRunId, payload?.actor || job.actor || 'operator', payload?.reason || 'operator quarantine'),
  };
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

module.exports = { createPublishingHandlers, assertReleaseGate, materializeTrustedArtifact };
