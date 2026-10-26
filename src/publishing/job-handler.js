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
        const result = await client.query(
          `SELECT p.*, a.storage_uri, a.content_hash AS artifact_hash
           FROM publish_runs p JOIN artifacts a ON a.id=p.render_artifact_id
           WHERE p.id=$1 FOR UPDATE OF p`, [runId]);
        run = result.rows[0];
        if (!run) throw Object.assign(new Error('Unknown publish run ' + runId), { retryable: false });
        if (run.status === 'PUBLISHED') {
          await client.query('COMMIT');
          return { id: run.external_id, url: run.external_url, alreadyPublished: true };
        }
        if (!run.storage_uri) throw Object.assign(new Error('Approved render has no storage URI'), { retryable: false });
        if (run.status === 'UPLOADING' && run.lease_until && new Date(run.lease_until).getTime() > Date.now() && run.lease_owner !== workerId) {
          throw Object.assign(new Error('Publish run is leased by another worker'), { retryable: true });
        }
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
          render: run.render_artifact_id, renderHash: run.artifact_hash, destination: run.destination, metadata: run.metadata || {},
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
      } finally { client.release(); }

      const persistSession = async (sessionUri) => {
        const saved = await pool.query(
          `UPDATE publish_runs SET upload_session_uri=$1
           WHERE id=$2 AND request_fingerprint=$3 AND lease_owner=$4 AND status='UPLOADING'
           RETURNING id`,
          [sessionUri, runId, run.request_fingerprint, workerId],
        );
        if (!saved.rows[0]) throw Object.assign(new Error('Publish lease was lost before the upload session could be saved'), { retryable: true });
      };

      try {
        const result = await publisher.createSession({
          sourceUri: run.storage_uri,
          metadata: run.metadata || {},
          requestFingerprint: run.request_fingerprint,
          existingSessionUri: run.upload_session_uri || null,
          onSession: persistSession,
        });
        const finalize = await pool.connect();
        try {
          await finalize.query('BEGIN');
          const locked = await finalize.query('SELECT * FROM publish_runs WHERE id=$1 FOR UPDATE', [runId]);
          const latest = locked.rows[0];
          if (!latest || latest.status !== 'UPLOADING' || latest.lease_owner !== workerId || latest.request_fingerprint !== run.request_fingerprint) {
            throw Object.assign(new Error('Publish lease was lost after upload completion; reconcile the saved YouTube session before retrying'), { retryable: true, uploadSessionUri: latest?.upload_session_uri || run.upload_session_uri || null });
          }
          await finalize.query(
            `UPDATE publish_runs SET status='PUBLISHED', external_id=$1, external_url=$2,
               finished_at=now(), upload_session_uri=NULL, lease_owner=NULL, lease_until=NULL,
               error=NULL WHERE id=$3`,
            [result.id, result.url, runId]);
          await finalize.query(
            `UPDATE episodes SET state='PUBLISHED', published_record_id=$1, revision=revision+1, updated_at=now()
             WHERE id=$2 AND state='PUBLISHING'`,
            [runId, run.episode_id]);
          await finalize.query(
            `INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details)
             VALUES($1,$2,$3,'EPISODE_PUBLISHED','publish_run',$4,$5::jsonb)`,
            [run.project_id, run.episode_id, run.created_by || workerId, runId, JSON.stringify({ externalId: result.id, externalUrl: result.url, renderArtifactId: run.render_artifact_id })]);
          await finalize.query('COMMIT');
        } catch (error) {
          try { await finalize.query('ROLLBACK'); } catch {}
          throw error;
        } finally { finalize.release(); }
        return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
      } catch (error) {
        const sessionUri = error.uploadSessionUri || run.upload_session_uri || null;
        await pool.query(
          `UPDATE publish_runs SET status='FAILED', upload_session_uri=COALESCE($1,upload_session_uri),
             error=$2::jsonb, finished_at=now(), lease_owner=NULL, lease_until=NULL
           WHERE id=$3 AND request_fingerprint=$4 AND lease_owner=$5 AND status='UPLOADING'`,
          [sessionUri, JSON.stringify({ message: error.message, status: error.status || null, uploadRange: error.uploadRange || null }), runId, run.request_fingerprint, workerId]);
        logger.error?.('YouTube publish ' + runId + ' failed: ' + error.message);
        throw error;
      }
    },
  };
}
module.exports = { createPublishingHandlers };
