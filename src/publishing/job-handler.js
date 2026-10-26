const { YouTubePublisher } = require('./youtube-publisher');

function createPublishingHandlers({ pool, publisher = new YouTubePublisher(), logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  return {
    'publish:youtube': async (payload) => {
      const runId = payload?.publishRunId;
      if (!runId) throw Object.assign(new Error('publishRunId is required'), { retryable: false });
      const current = await pool.query(`SELECT p.*, a.storage_uri FROM publish_runs p JOIN artifacts a ON a.id=p.render_artifact_id WHERE p.id=$1`, [runId]);
      const run = current.rows[0];
      if (!run) throw Object.assign(new Error(`Unknown publish run ${runId}`), { retryable: false });
      if (run.status === 'PUBLISHED') return { id: run.external_id, url: run.external_url, alreadyPublished: true };
      if (!run.storage_uri) throw Object.assign(new Error('Approved render has no storage URI'), { retryable: false });
      await pool.query(`UPDATE publish_runs SET status='UPLOADING', started_at=COALESCE(started_at,now()) WHERE id=$1`, [runId]);
      try {
        const result = await publisher.publish({ sourceUri: run.storage_uri, metadata: run.metadata || {}, externalId: run.external_id });
        await pool.query(`UPDATE publish_runs SET status='PUBLISHED', external_id=$1, external_url=$2, finished_at=now(), error=NULL WHERE id=$3`, [result.id, result.url, runId]);
        await pool.query(`UPDATE episodes SET state='PUBLISHED', published_record_id=$1, revision=revision+1, updated_at=now() WHERE id=$2 AND state='PUBLISHING'`, [runId, run.episode_id]);
        return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
      } catch (error) {
        logger.error?.(`YouTube publish ${runId} failed: ${error.message}`);
        await pool.query(`UPDATE publish_runs SET status='FAILED', error=$1::jsonb, finished_at=now() WHERE id=$2`, [JSON.stringify({ message: error.message, status: error.status || null }), runId]);
        throw error;
      }
    },
  };
}

module.exports = { createPublishingHandlers };
