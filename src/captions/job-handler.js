const { randomUUID } = require('node:crypto');
const { buildCaptionBundle } = require('./caption-worker');
const { PersistentProductionRepository } = require('../persistence/production-repository');

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function createCaptionJobHandler({ pool, maxCueMs = Number(process.env.FORGE_CAPTION_MAX_CUE_MS || 7000), logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  const repository = new PersistentProductionRepository({ pool });
  return async function captionJobHandler(payload, job) {
    const episodeId = String(payload?.episodeId || job?.episode_id || '');
    if (!episodeId) throw Object.assign(new Error('caption job requires episodeId'), { retryable: false });
    const transcript = await findTranscriptArtifact(repository, episodeId, payload?.transcriptArtifactId);
    if (!transcript) throw Object.assign(new Error('No immutable transcript artifact is available for captions'), { retryable: false });
    const timeline = await findTimelineArtifact(repository, episodeId, payload?.timelineArtifactId);
    const transcriptContent = transcript.content_json;
    const serialized = JSON.stringify(transcriptContent || {});
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw Object.assign(new Error('Transcript artifact exceeds caption worker input limit'), { retryable: false });
    const transcriptPayload = transcriptContent?.content && transcriptContent.content.segments ? transcriptContent.content : transcriptContent;
    const bundle = buildCaptionBundle({ transcript: transcriptPayload, transcriptArtifact: transcript, timelineArtifact: timeline, maxCueMs });
    const transcriptVersionId = transcript.version_id;
    const timelineVersionId = timeline?.version_id || null;
    const inputVersionIds = [transcriptVersionId, timelineVersionId].filter(Boolean);
    const versionId = `caption:${bundle.checksums.metadata}`;
    const versionPayload = {
      schemaVersion: 'forge-caption-version-v1',
      inputArtifactIds: [transcript.id, ...(timeline ? [timeline.id] : [])],
      inputVersionIds,
      checksums: bundle.checksums,
      cueCount: bundle.metadata.cueCount,
      language: bundle.metadata.language,
    };
    await repository.db.withTransaction(async (client) => {
      const existingVersion = await client.query('SELECT id, episode_id, kind FROM version_records WHERE id=$1', [versionId]);
      if (!existingVersion.rows[0]) {
        await client.query('INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
          [versionId, episodeId, 'caption', JSON.stringify(versionPayload), bundle.checksums.metadata, 'caption-worker']);
        for (const dependencyId of inputVersionIds) {
          await client.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, versionId, dependencyId]);
        }
      } else if (existingVersion.rows[0].episode_id !== episodeId || existingVersion.rows[0].kind !== 'caption') {
        throw Object.assign(new Error('Caption version identity conflicts with episode'), { retryable: false });
      }
      await insertCaptionArtifact(client, { id: `${versionId}:vtt`, episodeId, versionId, content: bundle.vtt, mediaType: 'text/vtt; charset=utf-8', inputVersionIds, metadata: { format: 'vtt', byteLength: Buffer.byteLength(bundle.vtt, 'utf8'), sha256: bundle.checksums.vtt, sourceTranscriptArtifactId: transcript.id } });
      await insertCaptionArtifact(client, { id: `${versionId}:srt`, episodeId, versionId, content: bundle.srt, mediaType: 'application/x-subrip; charset=utf-8', inputVersionIds, metadata: { format: 'srt', byteLength: Buffer.byteLength(bundle.srt, 'utf8'), sha256: bundle.checksums.srt, sourceTranscriptArtifactId: transcript.id } });
      await insertCaptionArtifact(client, { id: `${versionId}:metadata`, episodeId, versionId, content: bundle.metadata, mediaType: 'application/json', inputVersionIds, metadata: { format: 'caption-metadata', byteLength: Buffer.byteLength(JSON.stringify(bundle.metadata), 'utf8'), sha256: bundle.checksums.metadata, sourceTranscriptArtifactId: transcript.id } });
      await client.query(`INSERT INTO caption_runs(id,episode_id,transcript_artifact_id,transcript_version_id,timeline_artifact_id,timeline_version_id,caption_version_id,status,idempotency_key,checksums,metadata,created_at,finished_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,$9::jsonb,$10::jsonb,now(),now())
        ON CONFLICT (idempotency_key) DO UPDATE SET status='SUCCEEDED', finished_at=COALESCE(caption_runs.finished_at, now())`,
        [job?.id || randomUUID(), episodeId, transcript.id, transcript.version_id, timeline?.id || null, timelineVersionId, versionId,
          `caption:${episodeId}:${transcript.id}:${timeline?.id || 'none'}`, JSON.stringify(bundle.checksums), JSON.stringify({ cueCount: bundle.metadata.cueCount, language: bundle.metadata.language })]);
    });
    logger.log?.(`Forge captions generated for episode ${episodeId} from transcript ${transcript.id}`);
    return { episodeId, captionVersionId: versionId, artifactIds: [`${versionId}:vtt`, `${versionId}:srt`, `${versionId}:metadata`], checksums: bundle.checksums, transcriptArtifactId: transcript.id };
  };
}

async function findTranscriptArtifact(repository, episodeId, artifactId) {
  const result = artifactId
    ? await repository.db.pool.query("SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind IN ('transcript','transcription')", [artifactId, episodeId])
    : await repository.db.pool.query("SELECT * FROM artifacts WHERE episode_id=$1 AND kind IN ('transcript','transcription') ORDER BY created_at DESC, id DESC LIMIT 1", [episodeId]);
  return result.rows[0] || null;
}

async function findTimelineArtifact(repository, episodeId, artifactId) {
  const result = artifactId
    ? await repository.db.pool.query("SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind='timeline'", [artifactId, episodeId])
    : await repository.db.pool.query("SELECT * FROM artifacts WHERE episode_id=$1 AND kind='timeline' ORDER BY created_at DESC, id DESC LIMIT 1", [episodeId]);
  return result.rows[0] || null;
}

async function insertCaptionArtifact(client, { id, episodeId, versionId, content, mediaType, inputVersionIds, metadata }) {
  const contentJson = JSON.stringify({ value: content });
  const contentHash = require('node:crypto').createHash('sha256').update(contentJson).digest('hex');
  await client.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'caption-worker',$8::jsonb,$9::jsonb,'caption-worker') ON CONFLICT (id) DO NOTHING`,
    [id, episodeId, 'caption', versionId, contentJson, contentHash, mediaType, JSON.stringify(inputVersionIds), JSON.stringify(metadata)]);
}

module.exports = { createCaptionJobHandler, findTranscriptArtifact, findTimelineArtifact };
