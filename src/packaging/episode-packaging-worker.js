const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { PersistentProductionRepository } = require('../persistence/production-repository');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4']);
const SUPPORTED_CONTAINERS = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'mp4']);

function fail(message, code = 'PACKAGING_FAILED', retryable = false, details = {}) {
  return Object.assign(new Error(message), { code, retryable, diagnostics: details });
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function assertNotAborted(signal) { if (signal?.aborted) throw fail('Packaging job was cancelled', 'CANCELLED'); }

function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxOutputBytes = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env });
    let stdout = Buffer.alloc(0); let stderr = ''; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { child.kill('SIGKILL'); finish(reject, fail('Media inspection was cancelled', 'CANCELLED')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, fail(`Media inspection timed out after ${timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)); }, timeoutMs); timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > maxOutputBytes) { child.kill('SIGKILL'); finish(reject, fail('Media inspector output exceeded the configured bound', 'INSPECTOR_OUTPUT_TOO_LARGE')); } });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(reject, fail(`Unable to start media inspector: ${error.message}`, 'INSPECTOR_UNAVAILABLE', true)));
    child.on('close', (code, sig) => code === 0 ? finish(resolve, stdout) : finish(reject, fail(`Media inspector failed (${code || sig})${stderr ? `: ${stderr.trim()}` : ''}`, 'MEDIA_UNSUPPORTED')));
  });
}

async function inspectMedia(buffer, contentType, { ffprobeCommand = process.env.FORGE_FFPROBE_COMMAND || 'ffprobe', timeoutMs = 30_000 } = {}) {
  if (!SUPPORTED_VIDEO_TYPES.has(String(contentType || '').toLowerCase())) throw fail(`Unsupported final media type: ${contentType}`, 'MEDIA_UNSUPPORTED');
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw fail('Final media artifact is missing or truncated', 'ARTIFACT_CORRUPT');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-package-probe-')); const file = path.join(dir, 'final.mp4');
  try {
    await fs.writeFile(file, buffer, { flag: 'wx' });
    const output = await runCommand(ffprobeCommand, ['-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,pix_fmt,profile', '-of', 'json', file], { timeoutMs });
    let parsed; try { parsed = JSON.parse(output.toString('utf8')); } catch { throw fail('Media inspector returned malformed output', 'MEDIA_UNSUPPORTED'); }
    const video = (parsed.streams || []).find((stream) => stream.codec_type === 'video'); const format = parsed.format || {};
    const container = String(format.format_name || '').split(',')[0];
    if (!video || !SUPPORTED_CONTAINERS.has(String(format.format_name || '').toLowerCase())) throw fail('Final media is not a supported MP4 container with a video stream', 'MEDIA_UNSUPPORTED');
    const durationSeconds = Number(format.duration); const sizeBytes = Number(format.size || buffer.length);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw fail('Final media has no positive duration', 'MEDIA_UNSUPPORTED');
    if (!Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 16 || video.height < 16) throw fail('Final media has invalid dimensions', 'MEDIA_UNSUPPORTED');
    return { container, codec: video.codec_name || null, width: video.width, height: video.height, pixelFormat: video.pix_fmt || null, profile: video.profile || null, durationSeconds: Number(durationSeconds.toFixed(3)), sizeBytes };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function readBounded(stream, maxBytes) {
  const chunks = []; let total = 0;
  for await (const chunk of stream) { total += chunk.length; if (total > maxBytes) throw fail(`Artifact exceeds configured inspection bound of ${maxBytes} bytes`, 'ARTIFACT_TOO_LARGE'); chunks.push(chunk); }
  return Buffer.concat(chunks, total);
}

async function loadInputs(pool, { episodeId, finalMediaArtifactId, finalMediaVersionId }) {
  const episodeResult = await pool.query('SELECT * FROM episodes WHERE id=$1', [episodeId]); const episode = episodeResult.rows[0];
  if (!episode) throw fail('Episode not found', 'INVALID_PROVENANCE');
  const artifactId = finalMediaArtifactId || episode.approved_render_id || episode.current_render_id;
  if (!artifactId) throw fail('Episode has no approved final render', 'APPROVAL_REQUIRED');
  const artifactResult = await pool.query(`SELECT a.*, e.project_id, s.status AS storage_status, s.content_hash AS stored_hash, s.size_bytes AS stored_size
    FROM artifacts a JOIN episodes e ON e.id=a.episode_id LEFT JOIN storage_objects s ON s.artifact_id=a.id
    WHERE a.id=$1 AND a.episode_id=$2`, [artifactId, episodeId]);
  const media = artifactResult.rows[0]; if (!media) throw fail('Approved final media artifact was not found', 'ARTIFACT_NOT_FOUND');
  const versionId = finalMediaVersionId || media.version_id;
  if (media.version_id !== versionId) throw fail('Final media version provenance mismatch', 'INVALID_PROVENANCE');
  if (media.kind !== 'render') throw fail('Packaging only accepts render artifacts', 'INVALID_PROVENANCE');
  if (episode.approved_render_id !== media.id || episode.current_render_id !== media.id || episode.state !== 'APPROVED') throw fail('Final media approval is stale or episode is not approved', 'STALE_GATE');
  if (!media.content_hash || !media.storage_uri) throw fail('Approved final media has no immutable checksum/storage URI', 'INVALID_PROVENANCE');
  if (media.storage_status && media.storage_status !== 'READY') throw fail(`Final media storage is ${String(media.storage_status).toLowerCase()}`, media.storage_status === 'MISSING' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_CORRUPT');
  if (media.stored_hash && media.stored_hash !== media.content_hash) throw fail('Final media storage checksum metadata mismatch', 'CHECKSUM_MISMATCH');
  const qa = await pool.query(`SELECT id, status, artifact_id, version_id, checks, created_at FROM qa_results
    WHERE episode_id=$1 AND artifact_id=$2 AND version_id=$3 AND status IN ('PASSED','WARNINGS') ORDER BY created_at DESC LIMIT 1`, [episodeId, media.id, media.version_id]);
  if (!qa.rows[0]) throw fail('Approved final media does not have a passing QA result', 'QA_BLOCKED');
  const approval = await pool.query(`SELECT id, target_id, target_version_id, decision, evidence, decided_at FROM approvals
    WHERE episode_id=$1 AND stage='FINAL_RENDER' AND target_id=$2 AND target_version_id=$3 AND decision='APPROVED' ORDER BY decided_at DESC LIMIT 1`, [episodeId, media.id, media.version_id]);
  if (!approval.rows[0]) throw fail('Final render approval gate is missing', 'APPROVAL_REQUIRED');
  const metadata = episode.metadata || {};
  const evidence = approval.rows[0].evidence || {};
  const metadataHash = sha256(stable(metadata));
  if (evidence.metadataHash && evidence.metadataHash !== metadataHash) throw fail('Approved episode metadata no longer matches approval evidence', 'STALE_GATE');
  return { episode, media, qa: qa.rows[0], approval: approval.rows[0], metadata, metadataHash };
}

function canonicalManifest({ episode, media, qa, approval, metadata, metadataHash, mediaInfo, mediaSizeBytes }) {
  const manifest = {
    schemaVersion: 'forge-episode-package-v1',
    packageType: 'youtube-long-form',
    episode: { id: episode.id, projectId: episode.project_id, title: episode.title, description: episode.description },
    metadata,
    media: { artifactId: media.id, versionId: media.version_id, sha256: media.content_hash, sizeBytes: mediaSizeBytes, mediaType: media.media_type, ...mediaInfo },
    gates: { qa: { id: qa.id, status: qa.status, artifactId: qa.artifact_id, versionId: qa.version_id, checks: qa.checks || [] }, approval: { id: approval.id, targetId: approval.target_id, targetVersionId: approval.target_version_id, decidedAt: approval.decided_at } },
    provenance: { inputArtifactIds: [media.id], inputVersionIds: [media.version_id], metadataHash, finalRenderApprovalId: approval.id, finalRenderApprovalEvidence: approval.evidence || {} },
  };
  return manifest;
}

async function executePackaging({ pool, storage, payload, job, signal, mediaInspector = inspectMedia, maxMediaBytes = Number(process.env.FORGE_PACKAGE_MAX_MEDIA_BYTES || DEFAULT_MAX_MEDIA_BYTES), maxManifestBytes = Number(process.env.FORGE_PACKAGE_MAX_MANIFEST_BYTES || DEFAULT_MAX_MANIFEST_BYTES), timeoutMs = Number(process.env.FORGE_PACKAGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required'); const episodeId = payload?.episodeId; if (!episodeId) throw fail('Packaging job requires episodeId', 'INVALID_JOB'); assertNotAborted(signal);
  const { episode, media, qa, approval, metadata, metadataHash } = await loadInputs(pool, { episodeId, finalMediaArtifactId: payload?.finalMediaArtifactId, finalMediaVersionId: payload?.finalMediaVersionId });
  const repository = new PersistentProductionRepository({ pool }); const artifactStorage = storage || new ArtifactStorageService({ storage: require('../storage').createStorageFromEnv(), repository });
  const inputFingerprint = sha256(stable({ schemaVersion: 'forge-episode-package-v1', episodeId, mediaArtifactId: media.id, mediaVersionId: media.version_id, mediaHash: media.content_hash, metadataHash, qaId: qa.id, approvalId: approval.id }));
  const packageId = `episode-package:${inputFingerprint}`; const packageVersionId = `package:${inputFingerprint}`;
  const existing = await pool.query('SELECT * FROM episode_packages WHERE id=$1 AND episode_id=$2', [packageId, episodeId]);
  if (existing.rows[0]) {
    const row = existing.rows[0]; if (row.manifest_hash !== inputFingerprint && row.manifest_hash !== sha256(JSON.stringify(row.manifest))) throw fail('Existing package has inconsistent immutable identity', 'IDEMPOTENCY_CONFLICT');
    return { stage: 'EPISODE_PACKAGING', episodeId, packageArtifactId: packageId, packageVersionId: row.version_id, manifestHash: row.manifest_hash, idempotent: true, status: row.status };
  }
  const opened = await artifactStorage.openArtifact({ artifactId: media.id, projectId: episode.project_id, expectedVersionId: media.version_id }); assertNotAborted(signal);
  const mediaBytes = await readBounded(opened.stream, maxMediaBytes); assertNotAborted(signal);
  if (sha256(mediaBytes) !== media.content_hash) throw fail('Final media checksum verification failed', 'CHECKSUM_MISMATCH');
  const mediaInfo = await mediaInspector(mediaBytes, media.media_type, { timeoutMs: Math.min(timeoutMs, 30_000) }); assertNotAborted(signal);
  const manifest = canonicalManifest({ episode, media, qa, approval, metadata, metadataHash, mediaInfo, mediaSizeBytes: mediaBytes.length });
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); if (manifestBytes.length > maxManifestBytes) throw fail('Canonical package manifest exceeds configured size bound', 'MANIFEST_TOO_LARGE');
  const manifestHash = sha256(manifestBytes);
  const packageInputFingerprint = sha256(stable({ manifest, manifestHash }));
  const versionId = `package:${packageInputFingerprint}`; const artifactId = `episode-package:${packageInputFingerprint}`;
  const existingByFingerprint = await pool.query('SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind=\'package\'', [artifactId, episodeId]);
  if (existingByFingerprint.rows[0]) return { stage: 'EPISODE_PACKAGING', episodeId, packageArtifactId: artifactId, packageVersionId: versionId, manifestHash, idempotent: true };
  const artifact = await artifactStorage.putArtifact({ episodeId, projectId: episode.project_id, versionId, kind: 'package', content: manifestBytes, contentType: 'application/json', expectedSha256: manifestHash, artifactId, createdBy: job?.created_by || 'worker', inputVersionIds: [media.version_id], metadata: { schemaVersion: 'forge-episode-package-v1', inputFingerprint, manifestHash, manifestSizeBytes: manifestBytes.length, finalMediaArtifactId: media.id, finalMediaVersionId: media.version_id, finalMediaSha256: media.content_hash, metadataHash, qaId: qa.id, approvalId: approval.id } });
  try {
    await pool.query(`INSERT INTO episode_packages (id,episode_id,version_id,final_media_artifact_id,final_media_version_id,metadata_hash,manifest_hash,manifest_size_bytes,status,manifest,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9::jsonb,$10)
      ON CONFLICT (episode_id,manifest_hash) DO NOTHING`, [artifactId, episodeId, versionId, media.id, media.version_id, metadataHash, manifestHash, manifestBytes.length, JSON.stringify(manifest), job?.created_by || 'worker']);
  } catch (error) { logger.error?.(`Episode package persistence reconciliation failed: ${error.message}`); throw Object.assign(error, { retryable: true, code: error.code || 'PERSISTENCE_RETRYABLE' }); }
  const persisted = await pool.query('SELECT id, version_id, manifest_hash, status FROM episode_packages WHERE id=$1', [artifactId]);
  if (!persisted.rows[0]) throw fail('Package artifact uploaded but logical package record is missing', 'PARTIAL_OUTPUT', true, { artifactId, manifestHash });
  return { stage: 'EPISODE_PACKAGING', episodeId, packageArtifactId: artifact.id, packageVersionId: persisted.rows[0].version_id, manifestHash, manifestSizeBytes: manifestBytes.length, mediaSha256: media.content_hash, idempotent: false, status: persisted.rows[0].status };
}

function createPackagingHandlers({ pool, storage, logger = console, mediaInspector } = {}) {
  if (!pool) throw new TypeError('pool is required');
  return { 'workflow:package': (payload, job) => executePackaging({ pool, storage, payload, job, logger, mediaInspector }) };
}

module.exports = { executePackaging, createPackagingHandlers, inspectMedia, canonicalManifest, stable, sha256, fail };
