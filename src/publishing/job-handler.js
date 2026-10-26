const { YouTubePublisher } = require('./youtube-publisher');
function createPublishingHandlers({ pool, publisher = new YouTubePublisher(), logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  return { 'publish:youtube': async (payload) => {
    const runId = payload?.publishRunId; if (!runId) throw Object.assign(new Error('publishRunId is required'), { retryable:false });
    const current = await pool.query(`SELECT p.*, pa.storage_uri package_storage_uri, pa.content_hash package_hash, pa.version_id package_version_id,
      pa.metadata package_artifact_metadata, ep.final_media_artifact_id, ep.final_media_version_id, ma.storage_uri media_storage_uri, ma.content_hash media_hash
      FROM publish_runs p LEFT JOIN artifacts pa ON pa.id=p.package_artifact_id LEFT JOIN episode_packages ep ON ep.id=p.package_artifact_id
      LEFT JOIN artifacts ma ON ma.id=ep.final_media_artifact_id WHERE p.id=$1`, [runId]);
    const run = current.rows[0]; if (!run) throw Object.assign(new Error(`Unknown publish run ${runId}`), { retryable:false });
    if (run.status === 'PUBLISHED') return { id:run.external_id, url:run.external_url, alreadyPublished:true };
    if (!run.package_artifact_id || !run.package_version_id) throw Object.assign(new Error('YouTube publishing requires a canonical episode package'), { retryable:false, code:'PACKAGE_REQUIRED' });
    if (!run.package_storage_uri || !run.package_hash || run.package_version_id !== run.package_version_id) throw Object.assign(new Error('Canonical package is missing immutable storage metadata'), { retryable:false, code:'PACKAGE_INVALID' });
    if (!run.final_media_artifact_id || !run.final_media_version_id || !run.media_storage_uri || !run.media_hash) throw Object.assign(new Error('Canonical package has no trusted final media component'), { retryable:false, code:'PACKAGE_INVALID' });
    await pool.query(`UPDATE publish_runs SET status='UPLOADING', started_at=COALESCE(started_at,now()) WHERE id=$1`, [runId]);
    try {
      const result = await publisher.publish({ sourceUri:run.media_storage_uri, metadata:run.metadata||{}, externalId:run.external_id, packageArtifactId:run.package_artifact_id, packageVersionId:run.package_version_id, mediaSha256:run.media_hash });
      await pool.query(`UPDATE publish_runs SET status='PUBLISHED', external_id=$1, external_url=$2, finished_at=now(), error=NULL WHERE id=$3`, [result.id,result.url,runId]);
      await pool.query(`UPDATE episodes SET state='PUBLISHED', published_record_id=$1, revision=revision+1, updated_at=now() WHERE id=$2 AND state='PUBLISHING'`, [runId,run.episode_id]);
      return { publishRunId:runId, externalId:result.id, externalUrl:result.url, reconciled:Boolean(result.reconciled), packageArtifactId:run.package_artifact_id };
    } catch(error) { logger.error?.(`YouTube publish ${runId} failed: ${error.message}`); await pool.query(`UPDATE publish_runs SET status='FAILED', error=$1::jsonb, finished_at=now() WHERE id=$2`, [JSON.stringify({message:error.message,status:error.status||null}),runId]); throw error; }
  } };
}
module.exports={createPublishingHandlers};
