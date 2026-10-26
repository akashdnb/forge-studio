const { validateMediaArtifact } = require('../media/media-qa-runtime');

async function executeMediaQa({ payload, job, repository, logger = console, validator = validateMediaArtifact }) {
  const episodeId = payload?.episodeId;
  if (!episodeId) throw Object.assign(new Error('QA job requires episodeId'), { retryable: false });
  const artifactId = payload.renderArtifactId || payload.artifactId;
  if (!artifactId) throw Object.assign(new Error('QA job requires renderArtifactId'), { retryable: false });
  const resultId = `qa:${job.id}`;

  const existingResult = await repository.db.pool.query('SELECT * FROM qa_results WHERE id=$1', [resultId]);
  if (existingResult.rows[0]) {
    const existing = existingResult.rows[0];
    if (existing.episode_id !== episodeId || existing.artifact_id !== artifactId) throw Object.assign(new Error('QA idempotency key is bound to different provenance'), { retryable: false });
    return { stage: 'QA', episodeId, artifactId, versionId: existing.version_id, qaResultId: existing.id, status: existing.status, metadata: existing.metadata || {} };
  }

  const artifactResult = await repository.db.pool.query(
    `SELECT a.*, vr.payload AS version_payload, vr.content_hash AS version_content_hash
       FROM artifacts a JOIN version_records vr ON vr.id=a.version_id
      WHERE a.id=$1 AND a.episode_id=$2 AND a.kind='render'`,
    [artifactId, episodeId],
  );
  const artifact = artifactResult.rows[0];
  if (!artifact) throw Object.assign(new Error('Render artifact not found for QA'), { retryable: false });
  if (!artifact.storage_uri) throw Object.assign(new Error('Render artifact has no storage URI'), { retryable: false });

  const normalizedArtifact = { id: artifact.id, episodeId: artifact.episode_id, kind: artifact.kind, versionId: artifact.version_id, storageUri: artifact.storage_uri, contentHash: artifact.content_hash || artifact.version_content_hash || null, mediaType: artifact.media_type, metadata: artifact.metadata || {}, inputVersionIds: artifact.input_version_ids || [] };
  const qa = await validator({
    artifact: normalizedArtifact,
    payload: { ...payload, timelineMetadata: payload.timelineMetadata || artifact.metadata?.timeline || {} },
    timeoutMs: Number.parseInt(process.env.FORGE_QA_TIMEOUT_MS || '600000', 10),
    maxBytes: Number.parseInt(process.env.FORGE_QA_MAX_BYTES || String(5 * 1024 * 1024 * 1024), 10),
    ffprobePath: process.env.FORGE_FFPROBE_PATH || 'ffprobe', ffmpegPath: process.env.FORGE_FFMPEG_PATH || 'ffmpeg',
    allowedHosts: String(process.env.FORGE_QA_ALLOWED_MEDIA_HOSTS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
  });

  const persisted = await repository.recordQa({ id: resultId, episodeId, artifactId: artifact.id, versionId: artifact.version_id, status: qa.status, checks: qa.checks, runner: 'forge-media-qa-v1', metadata: { ...qa, jobId: job.id, attempt: job.attempts, artifactSha256: qa.checksum?.hash || null, provenance: { renderArtifactId: artifact.id, renderVersionId: artifact.version_id, inputVersionIds: artifact.input_version_ids || [] } } });
  if (qa.status === 'FAILED') {
    const error = new Error('Media QA failed'); error.retryable = qa.checks.some((c) => c.name === 'execution' && c.details?.retryable); error.qaResultId = persisted.id || resultId; error.qaResult = qa; throw error;
  }
  logger.log?.(`Forge media QA ${qa.status} for render ${artifact.id}`);
  return { stage: 'QA', episodeId, artifactId: artifact.id, versionId: artifact.version_id, qaResultId: persisted.id || resultId, status: qa.status, metadata: qa };
}
module.exports = { executeMediaQa };
