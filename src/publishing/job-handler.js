const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const { YouTubePublisher, redactProviderResponse } = require('./youtube-publisher');

function createPublishingHandlers({ pool, storage, publisher = new YouTubePublisher(), logger = console, now = () => new Date() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  if (!storage || typeof storage.download !== 'function') throw new TypeError('storage backend is required');
  return {
    'publish:youtube': async (payload, job = {}) => publishRun({ pool, storage, publisher, logger, now, payload, job }),
  };
}

async function publishRun({ pool, storage, publisher, logger, now, payload, job }) {
  const runId = payload?.publishRunId;
  if (!runId) throw Object.assign(new Error('publishRunId is required'), { retryable: false, code: 'INVALID_JOB' });
  const current = await pool.query(`SELECT p.*, e.state AS episode_state, e.approved_render_id, e.current_render_id, e.revision AS episode_revision,
      a.kind AS artifact_kind, a.version_id AS artifact_version_id, a.content_hash, a.media_type, a.metadata AS artifact_metadata,
      s.storage_key, s.content_hash AS storage_hash, s.status AS storage_status,
      q.status AS qa_status, q.created_at AS qa_created_at,
      ap.decision AS approval_decision, ap.target_id AS approval_target_id, ap.target_version_id AS approval_version_id, ap.decided_at AS approval_decided_at
    FROM publish_runs p
    JOIN episodes e ON e.id=p.episode_id
    JOIN artifacts a ON a.id=p.render_artifact_id
    LEFT JOIN storage_objects s ON s.artifact_id=a.id
    LEFT JOIN LATERAL (SELECT status,created_at FROM qa_results WHERE artifact_id=a.id AND version_id=a.version_id ORDER BY created_at DESC LIMIT 1) q ON true
    LEFT JOIN LATERAL (SELECT decision,target_id,target_version_id,decided_at FROM approvals WHERE episode_id=p.episode_id AND stage='FINAL_RENDER' ORDER BY decided_at DESC LIMIT 1) ap ON true
    WHERE p.id=$1`, [runId]);
  const run = current.rows[0];
  if (!run) throw Object.assign(new Error(`Unknown publish run ${runId}`), { retryable: false, code: 'NOT_FOUND' });
  if (run.status === 'PUBLISHED') return { publishRunId: runId, externalId: run.external_id, externalUrl: run.external_url, alreadyPublished: true };
  if (['CANCELLED', 'RECONCILIATION_REQUIRED'].includes(run.status)) throw Object.assign(new Error(`Publish run is terminal: ${run.status}`), { retryable: false, code: run.status });

  assertReleaseGate(run);
  await assertJobNotCancelled(pool, job.id);

  const artifact = await materializeTrustedArtifact({ storage, run });
  const controller = new AbortController();
  const cancellation = watchCancellation(pool, job.id, controller, 2000);
  try {
    await pool.query(`UPDATE publish_runs SET status='UPLOADING', started_at=COALESCE(started_at,$1), attempt=$2, last_provider_status=NULL, last_provider_reason=NULL WHERE id=$3 AND status IN ('QUEUED','UPLOADING')`, [now(), Math.max(1, Number(job.attempts || run.attempt || 1)), runId]);
    const result = await publisher.publish({
      sourcePath: artifact.path,
      metadata: run.metadata,
      externalId: run.external_id,
      uploadSessionUri: run.upload_session_uri,
      signal: controller.signal,
      onSession: async (sessionUri) => {
        await pool.query('UPDATE publish_runs SET upload_session_uri=$1 WHERE id=$2 AND status=\'UPLOADING\'', [sessionUri, runId]);
      },
    });
    await pool.query(`UPDATE publish_runs SET status='PUBLISHED', external_id=$1, external_url=$2, provider_response=$3::jsonb,
      upload_session_uri=NULL, finished_at=$4, error=NULL, last_provider_status=201, last_provider_reason=NULL WHERE id=$5`,
    [result.id, result.url, JSON.stringify(redactProviderResponse(result.response || {})), now(), runId]);
    await pool.query(`UPDATE episodes SET state='PUBLISHED', published_record_id=$1, revision=revision+1, updated_at=$2 WHERE id=$3 AND state='PUBLISHING' AND approved_render_id=$4`, [runId, now(), run.episode_id, run.render_artifact_id]);
    return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
  } catch (error) {
    const cancelled = error.code === 'JOB_CANCELLED' || controller.signal.aborted;
    const terminal = cancelled || error.terminalState === 'FAILED' || error.terminalState === 'CANCELLED' || error.terminalState === 'RECONCILIATION_REQUIRED' || (error.retryable !== true && ![408, 429, 500, 502, 503, 504].includes(error.status));
    const terminalState = cancelled ? 'CANCELLED' : (error.terminalState || (terminal ? 'FAILED' : null));
    const maxed = Number(job.attempts || 1) >= Number(job.max_attempts || 3);
    if (terminalState === 'RECONCILIATION_REQUIRED') {
      await pool.query(`UPDATE publish_runs SET status='RECONCILIATION_REQUIRED', error=$1::jsonb, finished_at=$2 WHERE id=$3`, [safeError(error), now(), runId]);
    } else if (terminalState === 'CANCELLED') {
      await pool.query(`UPDATE publish_runs SET status='CANCELLED', error=$1::jsonb, finished_at=$2 WHERE id=$3`, [safeError(error), now(), runId]);
    } else if (terminal || maxed) {
      await pool.query(`UPDATE publish_runs SET status='FAILED', error=$1::jsonb, finished_at=$2 WHERE id=$3`, [safeError(error), now(), runId]);
    } else {
      await pool.query(`UPDATE publish_runs SET status='UPLOADING', error=$1::jsonb WHERE id=$2`, [safeError(error), runId]);
    }
    logger.error?.(`YouTube publish ${runId} failed: ${error.message}`);
    throw Object.assign(error, { retryable: terminalState ? false : error.retryable !== false });
  } finally {
    clearInterval(cancellation);
    await fsp.rm(artifact.path, { force: true }).catch(() => {});
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
  if (run.media_type !== 'video/mp4') throw Object.assign(new Error('Only an MP4 render can be published to YouTube'), { retryable: false, code: 'INVALID_MEDIA_TYPE' });
  if (!['PASSED', 'WARNINGS'].includes(run.qa_status)) throw Object.assign(new Error('Latest QA result is not passing'), { retryable: false, code: 'QA_BLOCKED' });
  if (run.approval_decision !== 'APPROVED' || run.approval_target_id !== run.render_artifact_id || run.approval_version_id !== run.render_version_id) throw Object.assign(new Error('Final render approval does not match the publish artifact'), { retryable: false, code: 'APPROVAL_BLOCKED' });
}

async function materializeTrustedArtifact({ storage, run }) {
  const temp = path.join(os.tmpdir(), `forge-youtube-${run.id}-${cryptoRandom()}.mp4`);
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

async function assertJobNotCancelled(pool, jobId) {
  if (!jobId) return;
  const result = await pool.query('SELECT status FROM forge_jobs WHERE id=$1', [jobId]);
  if (result.rows[0]?.status === 'CANCELLED') throw Object.assign(new Error('Publish job was cancelled'), { code: 'JOB_CANCELLED', retryable: false, terminalState: 'CANCELLED' });
}

function watchCancellation(pool, jobId, controller, intervalMs) {
  if (!jobId) return null;
  const timer = setInterval(() => {
    pool.query('SELECT status FROM forge_jobs WHERE id=$1', [jobId]).then((result) => {
      if (result.rows[0]?.status === 'CANCELLED') controller.abort();
    }).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function safeError(error) {
  return JSON.stringify({
    code: error.code || 'PUBLISH_FAILED',
    message: error.message || String(error),
    status: error.status || null,
    providerReason: error.providerReason || null,
    retryable: error.retryable === true,
    terminalState: error.terminalState || null,
  });
}

function cryptoRandom() { return Math.random().toString(16).slice(2); }

module.exports = { createPublishingHandlers, assertReleaseGate, materializeTrustedArtifact };
