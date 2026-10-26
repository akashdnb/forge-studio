const crypto = require('node:crypto');
const { YouTubePublisher } = require('./youtube-publisher');

function createPublishingHandlers({ pool, publisher = new YouTubePublisher(), logger = console, leaseSeconds = 600 } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('a pg-compatible pool is required');
  return {
    'publish:youtube': async (payload, job = {}) => {
      const runId = payload?.publishRunId;
      if (!runId) throw Object.assign(new Error('publishRunId is required'), { retryable: false });
      const workerId = job.worker_id || job.workerId || 'publish-worker';
      const client = await pool.connect();
      let run;
      try {
        await client.query('BEGIN');
        const current = await client.query(
          `SELECT p.*, a.storage_uri, a.content_hash AS artifact_hash
           FROM publish_runs p JOIN artifacts a ON a.id=p.render_artifact_id
           WHERE p.id=$1 FOR UPDATE OF p`, [runId]);
        run = current.rows[0];
        if (!run) throw Object.assign(new Error('Unknown publish run ' + runId), { retryable: false });
        if (run.status === 'PUBLISHED') {
          await client.query('COMMIT');
          return { id: run.external_id, url: run.external_url, alreadyPublished: true };
        }
        if (!run.storage_uri) throw Object.assign(new Error('Approved render has no storage URI'), { retryable: false });
        if (run.status === 'UPLOADING' && run.lease_until && new Date(run.lease_until).getTime() > Date.now() && run.lease_owner !== workerId) {
          throw Object.assign(new Error('Publish run is leased by another worker'), { retryable: true });
        }
        const metadata = run.metadata || {};
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
          render: run.render_artifact_id,
          renderHash: run.artifact_hash,
          destination: run.destination,
          metadata,
        })).digest('hex');
        if (run.request_fingerprint && run.request_fingerprint !== fingerprint) {
          throw Object.assign(new Error('Publish request fingerprint changed after upload started'), { retryable: false });
        }
        await client.query(
          `UPDATE publish_runs SET status='UPLOADING', lease_owner=$1,
             lease_until=now()+($2::text || ' seconds')::interval,
             request_fingerprint=$3, render_content_hash=COALESCE(render_content_hash,$4),
             attempt=attempt+CASE WHEN status='FAILED' THEN 1 ELSE 0 END,
             started_at=COALESCE(started_at,now()), error=NULL WHERE id=$5`,
          [workerId, leaseSeconds, fingerprint, run.artifact_hash, runId]);
        await client.query('COMMIT');
        run.request_fingerprint = fingerprint;
        run.lease_owner = workerId;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        client.release();
      }

      try {
        // Resume from persisted YouTube session URL when available. Do not guess a
        // new upload after a partial upload; persist the session if the provider
        // returns an incomplete resumable response so the retry can continue.
        const result = await publisher.createSession({
          sourceUri: run.storage_uri,
          metadata: run.metadata || {},
          requestFingerprint: run.request_fingerprint,
          existingSessionUri: run.upload_session_uri || null,
        });
        await pool.query(
          `UPDATE publish_runs SET status='PUBLISHED', external_id=$1, external_url=$2,
             finished_at=now(), upload_session_uri=NULL, lease_owner=NULL, lease_until=NULL,
             error=NULL WHERE id=$3 AND request_fingerprint=$4 AND lease_owner=$5`,
          [result.id, result.url, runId, run.request_fingerprint, workerId]);
        await pool.query(
          `UPDATE episodes SET state='PUBLISHED', published_record_id=$1,
             revision=revision+1, updated_at=now() WHERE id=$2 AND state='PUBLISHING'`,
          [runId, run.episode_id]);
        return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
      } catch (error) {
        const sessionUri = error.uploadSessionUri || run.upload_session_uri || null;
        await pool.query(
          `UPDATE publish_runs SET status='FAILED', upload_session_uri=COALESCE($1,upload_session_uri),
             error=$2::jsonb, finished_at=now(), lease_owner=NULL, lease_until=NULL
           WHERE id=$3 AND request_fingerprint=$4 AND lease_owner=$5`,
          [sessionUri, JSON.stringify({ message: error.message, status: error.status || null, uploadRange: error.uploadRange || null }), runId, run.request_fingerprint, workerId]);
        logger.error?.('YouTube publish ' + runId + ' failed: ' + error.message);
        throw error;
      }
    },
  };
}

module.exports = { createPublishingHandlers };
