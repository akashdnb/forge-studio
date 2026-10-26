const { Readable } = require('node:stream');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { compileTimeline, COMPILER_VERSION } = require('./timeline-manifest-compiler');

const MANIFEST_KIND = 'render-manifest';
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

function immutableFailure(code, message, details = {}) { return Object.assign(new Error(message), { code, retryable: false, details }); }

async function loadVersionGraph(pool, episodeId, versionIds) {
  const result = await pool.query('SELECT id,episode_id,kind,payload,content_hash FROM version_records WHERE episode_id=$1 AND id = ANY($2::text[])', [episodeId, versionIds]);
  const versions = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  for (const id of versionIds) if (!versions[id]) throw immutableFailure('MISSING_INPUT', `Immutable input version ${id} is missing`);
  return versions;
}

async function assertApproved(pool, episodeId, timelineVersionId) {
  const result = await pool.query("SELECT id FROM approvals WHERE episode_id=$1 AND target_version_id=$2 AND decision='APPROVED' ORDER BY decided_at DESC LIMIT 1", [episodeId, timelineVersionId]);
  if (!result.rows[0]) throw immutableFailure('INPUT_NOT_APPROVED', `Timeline version ${timelineVersionId} is not approved`);
}

async function assertDependencies(pool, episodeId, timelineVersionId, inputVersionIds) {
  const result = await pool.query('SELECT depends_on_version_id FROM version_dependencies WHERE episode_id=$1 AND version_id=$2', [episodeId, timelineVersionId]);
  const declared = new Set(result.rows.map((row) => row.depends_on_version_id));
  for (const id of inputVersionIds) if (id !== timelineVersionId && !declared.has(id)) throw immutableFailure('PROVENANCE_MISMATCH', `Timeline ${timelineVersionId} does not declare dependency on ${id}`);
}

async function loadAssetArtifacts(pool, episodeId, versions) {
  const assetIds = Object.values(versions).filter((v) => v.kind === 'asset').map((v) => v.id);
  if (!assetIds.length) return {};
  const result = await pool.query(`SELECT a.id,a.version_id,a.content_hash,a.media_type,a.metadata,s.status,s.content_hash AS stored_hash
    FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id
    WHERE a.episode_id=$1 AND a.version_id = ANY($2::text[]) AND a.kind IN ('image','audio')`, [episodeId, assetIds]);
  const byVersion = {};
  for (const row of result.rows) {
    if (row.status && row.status !== 'READY') throw immutableFailure('MISSING_ASSET', `Asset artifact for ${row.version_id} is ${row.status}`);
    if (row.stored_hash && row.content_hash !== row.stored_hash) throw immutableFailure('ASSET_CHECKSUM_MISMATCH', `Asset artifact checksum mismatch for ${row.version_id}`);
    byVersion[row.version_id] = row;
  }
  return byVersion;
}

function createTimelineManifestHandler({ pool, storage, repository, logger = console, config = {} } = {}) {
  if (!pool?.query || !pool?.connect) throw new TypeError('pool is required');
  if (!storage?.upload) throw new TypeError('storage backend is required');
  const storageService = new ArtifactStorageService({ storage, repository });
  return async function handleManifest(payload, job) {
    const episodeId = payload?.episodeId;
    const timelineVersionId = payload?.timelineVersionId;
    if (!episodeId || !timelineVersionId) throw immutableFailure('MALFORMED_INPUT', 'Manifest job requires episodeId and timelineVersionId');
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw immutableFailure('BOUNDED_INPUT', 'Manifest job payload exceeds bounded size');

    const timelineResult = await pool.query('SELECT id,episode_id,kind,payload,content_hash FROM version_records WHERE id=$1 AND episode_id=$2', [timelineVersionId, episodeId]);
    const timelineVersion = timelineResult.rows[0];
    if (!timelineVersion || timelineVersion.kind !== 'timeline') throw immutableFailure('MISSING_INPUT', 'Immutable timeline version is missing');
    await assertApproved(pool, episodeId, timelineVersionId);
    const timeline = timelineVersion.payload?.timeline || timelineVersion.payload;
    if (!timeline?.tracks) throw immutableFailure('MALFORMED_TIMELINE', 'Timeline version has no tracks');
    const timelineHash = timelineVersion.content_hash;
    if (timelineHash && timelineHash !== require('./ffmpeg-renderer').sha256Json(timeline)) throw immutableFailure('STALE_INPUT', 'Timeline content hash does not match immutable payload');

    const requestedIds = [...new Set([timelineVersionId, ...(payload.inputVersionIds || []), ...(timeline.inputVersionIds || [])])];
    const versions = await loadVersionGraph(pool, episodeId, requestedIds);
    await assertDependencies(pool, episodeId, timelineVersionId, requestedIds);
    const assets = await loadAssetArtifacts(pool, episodeId, versions);
    for (const track of timeline.tracks) for (const segment of track.segments || []) {
      const sourceId = segment.assetVersionId || segment.sourceVersionId || (track.type === 'NARRATION' ? segment.narrationVersionId : null);
      if (!sourceId) continue;
      const source = versions[sourceId];
      if (!source) throw immutableFailure('MISSING_INPUT', `Segment ${segment.id} references missing version ${sourceId}`);
      if (track.type === 'VIDEO' && source.kind !== 'asset') throw immutableFailure('PROVENANCE_MISMATCH', `Video segment ${segment.id} does not reference an asset version`);
      if (track.type === 'NARRATION' && source.kind !== 'narration' && source.kind !== 'asset') throw immutableFailure('PROVENANCE_MISMATCH', `Narration segment ${segment.id} does not reference narration/audio provenance`);
      if (source.kind === 'asset' && !assets[sourceId]) throw immutableFailure('MISSING_ASSET', `No ready immutable artifact exists for asset version ${sourceId}`);
      const artifact = assets[sourceId];
      if (artifact?.metadata?.sourcePath) segment.sourcePath = artifact.metadata.sourcePath;
      if ((track.type === 'VIDEO' || track.type === 'NARRATION') && !segment.sourcePath && !segment.path) throw immutableFailure('MISSING_ASSET', `Segment ${segment.id} has no renderable source path`);
    }

    const compiled = compileTimeline({ episodeId, timeline, versions, config });
    const manifest = {
      schemaVersion: compiled.schemaVersion,
      manifestKind: MANIFEST_KIND,
      compilerVersion: COMPILER_VERSION,
      episodeId,
      timelineVersionId,
      timelineContentHash: timelineHash || require('./ffmpeg-renderer').sha256Json(timeline),
      inputVersionIds: compiled.inputVersionIds,
      durationSeconds: compiled.durationSeconds,
      streamExpectations: compiled.streamExpectations,
      renderParameters: compiled.renderParameters,
      tracks: compiled.tracks,
      checksum: compiled.checksum,
    };
    const content = Buffer.from(`${compiled.content}\n`, 'utf8');
    const checksum = require('node:crypto').createHash('sha256').update(content).digest('hex');
    if (checksum !== compiled.checksum) throw immutableFailure('INTERNAL_DETERMINISM_ERROR', 'Canonical manifest checksum mismatch');
    const versionId = `manifest:${compiled.checksum}`;
    const artifactId = `manifest:${compiled.checksum}`;
    const existing = await pool.query("SELECT a.*,s.status,s.content_hash AS stored_hash FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1 AND a.episode_id=$2 AND a.kind=$3", [artifactId, episodeId, MANIFEST_KIND]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.version_id !== versionId || row.content_hash !== checksum || row.metadata?.timelineVersionId !== timelineVersionId) throw immutableFailure('IDEMPOTENCY_CONFLICT', 'Existing manifest identity conflicts with immutable inputs');
      if (row.status === 'READY' && row.stored_hash === checksum) return { stage: 'TIMELINE_MANIFEST', episodeId, versionId, artifactId, checksum, durationSeconds: manifest.durationSeconds, idempotent: true };
    }
    const project = await pool.query('SELECT project_id FROM episodes WHERE id=$1', [episodeId]);
    if (!project.rows[0]) throw immutableFailure('MISSING_INPUT', `Episode ${episodeId} does not exist`);
    await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT (id) DO NOTHING`, [versionId, episodeId, MANIFEST_KIND, JSON.stringify(manifest), checksum, payload.actor || 'worker']);
    const artifact = await storageService.putArtifact({
      episodeId, projectId: project.rows[0].project_id, versionId, kind: MANIFEST_KIND,
      stream: Readable.from([content]), contentType: 'application/json', expectedSha256: checksum,
      artifactId, createdBy: payload.actor || 'worker', inputVersionIds: compiled.inputVersionIds,
      metadata: { compilerVersion: COMPILER_VERSION, timelineVersionId, timelineContentHash: manifest.timelineContentHash, durationSeconds: manifest.durationSeconds, checksum, immutable: true, streamExpectations: manifest.streamExpectations, renderParameters: manifest.renderParameters },
    });
    logger.log?.(`Forge deterministic timeline manifest completed for episode ${episodeId}`);
    return { stage: 'TIMELINE_MANIFEST', episodeId, versionId, artifactId, storageUri: artifact.storage_uri, checksum, durationSeconds: manifest.durationSeconds, compilerVersion: COMPILER_VERSION };
  };
}

module.exports = { createTimelineManifestHandler, MANIFEST_KIND, COMPILER_VERSION };
