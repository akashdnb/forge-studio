const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderTimeline, sha256Json } = require('./ffmpeg-renderer');

function createFfmpegRenderHandler({ pool, logger = console, render = renderTimeline } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  return async function handleRender(payload, job) {
    const episodeId = payload?.episodeId;
    if (!episodeId) throw Object.assign(new Error('Render job is missing episodeId'), { retryable: false });
    const timelineArtifact = Array.isArray(payload.timeline) ? payload.timeline.find((item) => item?.versionId && (item?.content?.tracks || item?.content?.timeline?.tracks)) : null;
    if (!timelineArtifact?.versionId) throw Object.assign(new Error('Render requires an immutable timeline artifact'), { retryable: false });
    const timelineVersion = await pool.query('SELECT id,episode_id,kind,payload,content_hash FROM version_records WHERE id=$1 AND episode_id=$2', [timelineArtifact.versionId, episodeId]);
    const version = timelineVersion.rows[0];
    if (!version || version.kind !== 'timeline') throw Object.assign(new Error('Render timeline version is missing or not a timeline'), { retryable: false });
    const timeline = version.payload?.tracks ? version.payload : version.payload?.timeline;
    if (!timeline?.tracks) throw Object.assign(new Error('Immutable timeline version has no timeline payload'), { retryable: false });
    const timelineContentHash = version.content_hash || sha256Json(timeline);
    if (sha256Json(timeline) !== timelineContentHash) throw Object.assign(new Error('Immutable timeline version content hash mismatch'), { retryable: false });
    if (timelineArtifact.contentHash && timelineArtifact.contentHash !== timelineContentHash) throw Object.assign(new Error('Timeline artifact content hash does not match immutable version'), { retryable: false });

    const versionId = `render:${job.id}`; const artifactId = `render:${job.id}`;
    const existing = await pool.query(`SELECT a.id,a.version_id,a.storage_uri,a.content_hash,a.media_type,a.metadata FROM artifacts a JOIN version_records vr ON vr.id=a.version_id WHERE a.id=$1 AND a.episode_id=$2 AND a.kind='render'`, [artifactId, episodeId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.metadata?.timelineVersionId !== timelineArtifact.versionId || row.metadata?.timelineContentHash !== timelineContentHash) throw Object.assign(new Error('Existing render artifact has conflicting immutable provenance'), { retryable: false });
      if (row.storage_uri?.startsWith('file://')) { try { await fs.access(new URL(row.storage_uri)); return { stage: 'RENDER', episodeId, versionId: row.version_id, artifactId: row.id, storageUri: row.storage_uri, checksum: row.content_hash, metadata: row.metadata, idempotent: true }; } catch {} }
      if (row.storage_uri && !row.storage_uri.startsWith('file://')) return { stage: 'RENDER', episodeId, versionId: row.version_id, artifactId: row.id, storageUri: row.storage_uri, checksum: row.content_hash, metadata: row.metadata, idempotent: true };
    }

    const workDir = process.env.FORGE_RENDER_WORKDIR || process.cwd();
    const outputDir = process.env.FORGE_RENDER_OUTPUT_DIR || path.join(workDir, '.forge-render-output');
    const outputPath = path.join(outputDir, `${artifactId.replace(/[^A-Za-z0-9._-]/g, '_')}.mp4`);
    const result = await render({ input: { timeline, timelineVersionId: timelineArtifact.versionId, timelineContentHash, inputVersionIds: payload.inputVersionIds || [timelineArtifact.versionId], workDir }, workDir, outputPath, timeoutMs: Number.parseInt(process.env.FORGE_RENDER_TIMEOUT_MS || String(15 * 60 * 1000), 10) });
    const storageUri = process.env.FORGE_RENDER_STORAGE_URI_PREFIX ? `${process.env.FORGE_RENDER_STORAGE_URI_PREFIX.replace(/\/$/, '')}/${path.basename(result.outputPath)}` : `file://${result.outputPath}`;
    const metadata = { ...result.metadata, jobId: job.id, attempt: job.attempts, immutable: true, timelineVersionId: timelineArtifact.versionId, timelineContentHash };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingVersion = await client.query('SELECT episode_id,kind FROM version_records WHERE id=$1 FOR UPDATE', [versionId]);
      if (existingVersion.rows[0] && (existingVersion.rows[0].episode_id !== episodeId || existingVersion.rows[0].kind !== 'render')) throw Object.assign(new Error('Render version identity conflicts with episode'), { retryable: false });
      if (!existingVersion.rows[0]) await client.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'render',$3::jsonb,$4,$5)`, [versionId, episodeId, JSON.stringify({ mediaType: 'video/mp4', checksum: result.checksum, timelineVersionId: timelineArtifact.versionId, timelineContentHash }), result.checksum, payload.actor || 'worker']);
      await client.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'render',$3,$4,NULL,$5,'video/mp4','forge',$6::jsonb,$7::jsonb,$8) ON CONFLICT (id) DO UPDATE SET storage_uri=EXCLUDED.storage_uri,content_hash=EXCLUDED.content_hash,metadata=EXCLUDED.metadata,input_version_ids=EXCLUDED.input_version_ids`, [artifactId, episodeId, versionId, storageUri, result.checksum, JSON.stringify([timelineArtifact.versionId]), JSON.stringify(metadata), payload.actor || 'worker']);
      const episode = await client.query('SELECT project_id FROM episodes WHERE id=$1 FOR SHARE', [episodeId]);
      if (!episode.rows[0]) throw Object.assign(new Error('Episode not found: ' + episodeId), { retryable: false });
      await client.query(`INSERT INTO storage_objects(id,project_id,artifact_id,uri,content_hash,media_type,size_bytes,metadata) VALUES($1,$2,$3,$4,$5,'video/mp4',$6,$7::jsonb) ON CONFLICT (uri) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,content_hash=EXCLUDED.content_hash,size_bytes=EXCLUDED.size_bytes,metadata=EXCLUDED.metadata`, [crypto.randomUUID(), episode.rows[0].project_id, artifactId, storageUri, result.checksum, result.sizeBytes, JSON.stringify({ schemaVersion: 'forge-storage-v1', immutable: true, timelineVersionId: timelineArtifact.versionId, timelineContentHash })]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    logger.log?.(`Forge FFmpeg render completed for episode ${episodeId}`);
    return { stage: 'RENDER', episodeId, versionId, artifactId, storageUri, checksum: result.checksum, sizeBytes: result.sizeBytes, metadata };
  };
}
module.exports = { createFfmpegRenderHandler };
