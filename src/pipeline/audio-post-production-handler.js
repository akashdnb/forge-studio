const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const { renderAudioPost, normalizeSegments, AUDIO_POST_SCHEMA } = require('./audio-post-production');

function immutableFailure(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function readStream(stream, maxBytes = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw immutableFailure('BOUNDED_INPUT', 'Audio post manifest exceeds maximum size'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

function createAudioPostProductionHandler({ pool, storage, repository, logger = console, render = renderAudioPost } = {}) {
  if (!pool?.query || !pool?.connect) throw new TypeError('pool is required');
  if (!storage?.upload || !storage?.download) throw new TypeError('storage backend is required');
  const repo = repository || new PersistentProductionRepository({ pool });
  const storageService = new ArtifactStorageService({ storage, repository: repo });

  return async function handleAudioPost(payload = {}, job) {
    const episodeId = payload.episodeId;
    const timelineVersionId = payload.timelineVersionId || payload.inputVersionIds?.find((id) => String(id).startsWith('timeline:'));
    if (!episodeId || !timelineVersionId) throw immutableFailure('MALFORMED_INPUT', 'Audio post-production requires episodeId and timelineVersionId');

    const timelineResult = await pool.query('SELECT id,episode_id,kind,payload,content_hash FROM version_records WHERE id=$1 AND episode_id=$2', [timelineVersionId, episodeId]);
    const timelineVersion = timelineResult.rows[0];
    if (!timelineVersion || timelineVersion.kind !== 'timeline') throw immutableFailure('MISSING_INPUT', 'Immutable timeline version is missing');
    const timeline = timelineVersion.payload?.timeline || timelineVersion.payload;
    if (!timeline?.tracks) throw immutableFailure('MALFORMED_TIMELINE', 'Timeline has no tracks');

    const segments = normalizeSegments(timeline.tracks, Number(timeline.durationSeconds || payload.durationSeconds));
    const sourceVersionIds = [...new Set(segments.map((segment) => segment.sourceVersionId))];
    if (!sourceVersionIds.length) throw immutableFailure('AUDIO_INPUT_MISSING', 'Timeline contains no audio sources');
    const episode = await pool.query('SELECT project_id FROM episodes WHERE id=$1', [episodeId]);
    if (!episode.rows[0]) throw immutableFailure('MISSING_INPUT', `Episode ${episodeId} does not exist`);

    const artifactsResult = await pool.query(`SELECT a.id,a.version_id,a.content_hash,a.media_type,a.metadata,s.status,s.content_hash AS stored_hash
      FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id
      WHERE a.episode_id=$1 AND a.version_id=ANY($2::text[]) AND a.kind IN ('audio','music','sfx','asset')
      ORDER BY a.created_at DESC`, [episodeId, sourceVersionIds]);
    const byVersion = new Map();
    for (const row of artifactsResult.rows) {
      if (!byVersion.has(row.version_id)) byVersion.set(row.version_id, row);
    }
    for (const id of sourceVersionIds) {
      const artifact = byVersion.get(id);
      if (!artifact) throw immutableFailure('MISSING_ASSET', `No audio artifact exists for ${id}`);
      if (artifact.status && artifact.status !== 'READY') throw immutableFailure('MISSING_ASSET', `Audio artifact ${artifact.id} is ${artifact.status}`);
      if (artifact.stored_hash && artifact.stored_hash !== artifact.content_hash) throw immutableFailure('ASSET_CHECKSUM_MISMATCH', `Audio artifact checksum mismatch for ${artifact.id}`);
    }

    const recipe = {
      schemaVersion: AUDIO_POST_SCHEMA,
      sampleRate: Number(payload.audioRecipe?.sampleRate || process.env.FORGE_AUDIO_SAMPLE_RATE || 48000),
      targetLufs: Number(payload.audioRecipe?.targetLufs ?? process.env.FORGE_AUDIO_TARGET_LUFS ?? -16),
      truePeak: Number(payload.audioRecipe?.truePeak ?? process.env.FORGE_AUDIO_TRUE_PEAK ?? -1.5),
      lra: Number(payload.audioRecipe?.lra ?? process.env.FORGE_AUDIO_LRA ?? 11),
      duckDb: Number(payload.audioRecipe?.duckDb ?? process.env.FORGE_AUDIO_DUCK_DB ?? -12),
      version: Number(payload.audioRecipe?.version || 1),
    };
    const identityInput = JSON.stringify({ timelineVersionId, timelineHash: timelineVersion.content_hash, sourceVersionIds, sourceChecksums: sourceVersionIds.map((id) => byVersion.get(id).content_hash), recipe, segments });
    const recipeIdentity = sha256(identityInput);
    const versionId = `audio-post:${recipeIdentity}`;
    const artifactId = `audio-post:${recipeIdentity}`;
    const existing = await pool.query(`SELECT a.id,a.version_id,a.content_hash,a.storage_uri,a.metadata,s.status,s.content_hash AS stored_hash
      FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1 AND a.episode_id=$2 AND a.kind='audio-post'`, [artifactId, episodeId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.version_id !== versionId || row.metadata?.recipeIdentity !== recipeIdentity) throw immutableFailure('IDEMPOTENCY_CONFLICT', 'Existing audio-post artifact conflicts with immutable recipe identity');
      if (row.status === 'READY' && row.stored_hash === row.content_hash) return { stage: 'AUDIO_POST', episodeId, versionId, artifactId, storageUri: row.storage_uri, checksum: row.content_hash, metadata: row.metadata, idempotent: true };
    }

    const workDir = process.env.FORGE_AUDIO_WORKDIR || await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-audio-post-'));
    const ownsWorkDir = !process.env.FORGE_AUDIO_WORKDIR;
    const sourceFiles = [];
    try {
      for (const sourceVersionId of sourceVersionIds) {
        const artifact = byVersion.get(sourceVersionId);
        const opened = await storageService.openArtifact({ artifactId: artifact.id, projectId: episode.rows[0].project_id });
        const extension = artifact.media_type?.includes('mpeg') ? '.mp3' : artifact.media_type?.includes('ogg') ? '.ogg' : artifact.media_type?.includes('mp4') ? '.m4a' : '.wav';
        const sourcePath = path.join(workDir, `source-${sha256(sourceVersionId).slice(0, 16)}${extension}`);
        await new Promise((resolve, reject) => { const output = fs.createWriteStream(sourcePath, { flags: 'wx' }); opened.stream.pipe(output); output.once('finish', resolve); output.once('error', reject); opened.stream.once('error', reject); });
        sourceFiles.push({ versionId: sourceVersionId, checksum: artifact.content_hash, path: sourcePath });
      }
      const outputPath = path.join(workDir, `audio-post-${recipeIdentity}.wav`);
      const result = await render({ inputFiles: sourceFiles, segments, durationSeconds: Number(timeline.durationSeconds), outputPath, recipe });
      const metadata = {
        schemaVersion: AUDIO_POST_SCHEMA,
        recipeIdentity,
        recipe,
        timelineVersionId,
        timelineContentHash: timelineVersion.content_hash,
        sourceVersionIds,
        sourceChecksums: sourceVersionIds.map((id) => byVersion.get(id).content_hash),
        durationSeconds: Number(timeline.durationSeconds),
        validation: result.validation,
        deterministic: true,
        immutable: true,
        jobId: job?.id || null,
        attempt: job?.attempts || 1,
      };
      await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by)
        VALUES($1,$2,'audio-post',$3::jsonb,$4,$5) ON CONFLICT (id) DO NOTHING`, [versionId, episodeId, JSON.stringify({ mediaType: 'audio/wav', checksum: result.checksum, metadata }), result.checksum, payload.actor || 'worker']);
      const artifact = await storageService.putArtifact({ episodeId, projectId: episode.rows[0].project_id, versionId, artifactId, kind: 'audio-post', stream: fs.createReadStream(result.outputPath), contentType: 'audio/wav', expectedSha256: result.checksum, inputVersionIds: [timelineVersionId, ...sourceVersionIds], source: 'forge', metadata, createdBy: payload.actor || 'worker' });
      logger.log?.(`Forge professional audio post-production completed for episode ${episodeId}`);
      return { stage: 'AUDIO_POST', episodeId, versionId, artifactId, storageUri: artifact.storage_uri, checksum: artifact.content_hash, sizeBytes: result.sizeBytes, metadata };
    } finally {
      if (ownsWorkDir) await fsp.rm(workDir, { recursive: true, force: true });
    }
  };
}

module.exports = { createAudioPostProductionHandler };
