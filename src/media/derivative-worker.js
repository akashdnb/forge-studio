const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline, Transform } = require('node:stream');
const { promisify } = require('node:util');
const { ArtifactAccessGateway } = require('../storage/artifact-access-gateway');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { derivativeIdentity, derivativeArtifactId, normalizeRecipe, stableJson } = require('./derivative-recipes');
const { MediaValidationService } = require('./content-validation');

const pipe = promisify(pipeline);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.FORGE_DERIVATIVE_TIMEOUT_MS || '300000', 10);
const MAX_INPUT_BYTES = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_INPUT_BYTES || String(2 * 1024 * 1024 * 1024), 10);
const MAX_OUTPUT_BYTES = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_OUTPUT_BYTES || String(512 * 1024 * 1024), 10);
const MAX_DURATION_SECONDS = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_INPUT_DURATION_SECONDS || '3600', 10);
const MAX_WIDTH = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_WIDTH || '7680', 10);
const MAX_HEIGHT = Number.parseInt(process.env.FORGE_DERIVATIVE_MAX_HEIGHT || '4320', 10);
const SAFE_CODEC = new Set(['h264','hevc','vp8','vp9','av1','mpeg4','mjpeg','png','jpeg','aac','mp3','opus','vorbis','flac','pcm_s16le','pcm_s24le','pcm_s32le','alaw','mulaw']);
const SAFE_FORMAT = new Set(['mov,mp4,m4a,3gp,3g2,mj2','matroska,webm','matroska','webm','avi','mpegts','wav','mp3','ogg','flac','image2','jpeg_pipe','png_pipe']);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha256File(file) { return new Promise((resolve, reject) => { const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file); stream.on('data', (chunk) => hash.update(chunk)); stream.once('error', reject); stream.once('end', () => resolve(hash.digest('hex'))); }); }

function ffprobeJson(input, { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', timeoutMs = 30000 } = {}) {
  return runProcess(ffprobePath, ['-v','error','-show_entries','format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels','-of','json',input], { timeoutMs }).then(({ stdout }) => {
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { throw Object.assign(new Error('ffprobe returned malformed metadata'), { code: 'MEDIA_METADATA_INVALID', retryable: false }); }
    return parsed;
  });
}

function runProcess(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onTick, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore','pipe','pipe'] });
    let stdout = ''; let stderr = ''; let settled = false; let timer;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024); });
    const interval = setInterval(async () => { try { const action = await onTick?.(); if (action === 'cancel') { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('Derivative job cancelled'), { code: 'JOB_CANCELLED', retryable: false })); } } catch (error) { child.kill('SIGKILL'); finish(reject, error); } }, 1000);
    interval.unref?.();
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: 'DERIVATIVE_TIMEOUT', retryable: true })); }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(reject, Object.assign(error, { retryable: error.code !== 'ENOENT' })));
    child.once('exit', (code, signal) => { clearInterval(interval); if (code === 0) finish(resolve, { stdout, stderr }); else finish(reject, Object.assign(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`), { code: 'FFMPEG_FAILED', retryable: false, stdout, stderr })); });
  });
}

function validateMediaMetadata(metadata, { maxDurationSeconds = MAX_DURATION_SECONDS } = {}) {
  const format = metadata?.format || {};
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const duration = Number(format.duration || 0);
  const size = Number(format.size || 0);
  if (!streams.length || !Number.isFinite(duration) || duration < 0 || duration > maxDurationSeconds) throw Object.assign(new Error(`Media duration exceeds ${maxDurationSeconds}s or is invalid`), { code: 'MEDIA_LIMIT', retryable: false });
  if (Number.isFinite(size) && size > MAX_INPUT_BYTES) throw Object.assign(new Error('Media input exceeds byte limit'), { code: 'MEDIA_LIMIT', retryable: false });
  if (format.format_name && !String(format.format_name).split(',').some((name) => SAFE_FORMAT.has(name))) throw Object.assign(new Error(`Unsupported or unsafe media container: ${format.format_name}`), { code: 'MEDIA_UNSUPPORTED', retryable: false });
  if (streams.length > 8) throw Object.assign(new Error('Media has too many streams'), { code: 'MEDIA_LIMIT', retryable: false });
  for (const stream of streams) {
    if (stream.codec_name && !SAFE_CODEC.has(stream.codec_name)) throw Object.assign(new Error(`Unsupported media codec: ${stream.codec_name}`), { code: 'MEDIA_UNSUPPORTED', retryable: false });
    if (stream.width && Number(stream.width) > MAX_WIDTH) throw Object.assign(new Error('Media width exceeds limit'), { code: 'MEDIA_LIMIT', retryable: false });
    if (stream.height && Number(stream.height) > MAX_HEIGHT) throw Object.assign(new Error('Media height exceeds limit'), { code: 'MEDIA_LIMIT', retryable: false });
  }
  return { durationSeconds: duration, sizeBytes: size, streams };
}

function outputSpec(recipe) {
  if (recipe.type === 'poster' || recipe.type === 'contact-sheet') return { ext: 'jpg', mediaType: 'image/jpeg' };
  if (recipe.type === 'waveform') return { ext: 'png', mediaType: 'image/png' };
  return { ext: 'mp4', mediaType: 'video/mp4' };
}

function ffmpegArgs(recipe, input, output, duration) {
  const vfScale = `scale=${recipe.width}:${recipe.height}:force_original_aspect_ratio=decrease,pad=${recipe.width}:${recipe.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  if (recipe.type === 'poster') return ['-hide_banner','-loglevel','error','-ss',String(recipe.timestampSeconds),'-i',input,'-frames:v','1','-vf',vfScale,'-q:v',String(Math.max(2, Math.round((100-recipe.quality)/10))),'-map_metadata','-1','-y',output];
  if (recipe.type === 'contact-sheet') { const fps = Math.max(1 / Math.max(duration, 1), recipe.count / Math.max(duration, 1)); return ['-hide_banner','-loglevel','error','-i',input,'-vf',`fps=${fps},${vfScale},tile=${recipe.columns}x${Math.ceil(recipe.count/recipe.columns)}:padding=4:margin=4:color=black`,'-frames:v','1','-q:v','4','-map_metadata','-1','-y',output]; }
  if (recipe.type === 'waveform') return ['-hide_banner','-loglevel','error','-i',input,'-map','0:a:0','-filter_complex',`aformat=channel_layouts=mono,showwavespic=s=${recipe.width}x${recipe.height}:colors=${recipe.colors}`,'-frames:v','1','-map_metadata','-1','-y',output];
  if (recipe.type === 'proxy') return ['-hide_banner','-loglevel','error','-i',input,'-t',String(Math.min(duration, recipe.maxDurationSeconds)), '-vf',vfScale,'-c:v',recipe.videoCodec,'-preset',recipe.preset,'-crf',String(recipe.crf),'-c:a',recipe.audioCodec,'-b:a','96k','-movflags','+faststart','-map_metadata','-1','-y',output];
  if (recipe.type === 'clip') return ['-hide_banner','-loglevel','error','-ss',String(recipe.startSeconds),'-i',input,'-t',String(recipe.durationSeconds),'-vf',vfScale,'-c:v',recipe.videoCodec,'-preset',recipe.preset,'-crf',String(recipe.crf),'-c:a',recipe.audioCodec,'-b:a','96k','-movflags','+faststart','-map_metadata','-1','-y',output];
  throw Object.assign(new Error('Unsupported derivative recipe'), { code: 'INVALID_RECIPE', retryable: false });
}

async function boundedDownload(stream, target, maxBytes, isCancelled) {
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; if (bytes > maxBytes) callback(Object.assign(new Error(`Input exceeds ${maxBytes} bytes`), { code: 'MEDIA_LIMIT', retryable: false })); else callback(null, chunk); } });
  const monitor = setInterval(async () => { if (await isCancelled()) stream.destroy(Object.assign(new Error('Derivative job cancelled'), { code: 'JOB_CANCELLED', retryable: false })); }, 500);
  monitor.unref?.();
  try { await pipe(stream, limiter, fs.createWriteStream(target, { flags: 'wx' })); return bytes; } finally { clearInterval(monitor); }
}

function createMediaDerivativeHandler({ pool, storage, repository, accessGateway = null, logger = console, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', workDir = process.env.FORGE_DERIVATIVE_WORKDIR || path.join(os.tmpdir(), 'forge-derivatives'), limits = {} } = {}) {
  if (!pool?.connect || !repository || !storage) throw new TypeError('pool, repository and storage are required');
  const gateway = accessGateway || new ArtifactAccessGateway({ repository, storage, workerActors: process.env.FORGE_ARTIFACT_WORKER_ACTORS || '' });
  const artifactStore = new ArtifactStorageService({ storage, repository });
  const validator = new MediaValidationService({ pool, workerId: process.env.FORGE_WORKER_ID || 'derivative-validator', logger, maxConcurrency: 2 });
  const maxInputBytes = limits.maxInputBytes || MAX_INPUT_BYTES;
  const maxOutputBytes = limits.maxOutputBytes || MAX_OUTPUT_BYTES;
  const timeoutMs = limits.timeoutMs || DEFAULT_TIMEOUT_MS;

  async function cancelled(jobId) {
    const result = await pool.query('SELECT cancellation_requested_at,timeout_at,status FROM forge_jobs WHERE id=$1', [jobId]);
    const row = result.rows[0];
    return !row || row.status === 'CANCELLED' || Boolean(row.cancellation_requested_at) || (row.timeout_at && new Date(row.timeout_at).getTime() <= Date.now());
  }

  async function withIdentityLock(identity, fn) {
    const client = await pool.connect();
    try { await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [identity]); return await fn(client); }
    finally { try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [identity]); } finally { client.release(); } }
  }

  return async function handle(payload, job) {
    const sourceArtifactId = payload?.sourceArtifactId || payload?.artifactId;
    const recipe = normalizeRecipe(payload?.recipe);
    if (!sourceArtifactId) throw Object.assign(new Error('sourceArtifactId is required'), { code: 'INVALID_INPUT', retryable: false });
    const source = await gateway.resolve({ artifactId: sourceArtifactId, actor: job.worker_id || process.env.FORGE_WORKER_ID || 'worker', action: 'metadata', purpose: 'worker' });
    const sourceHash = String(source.artifact.content_hash || '').toLowerCase();
    const { identity, recipeHash } = derivativeIdentity({ sourceChecksum: sourceHash, recipe });
    const artifactId = derivativeArtifactId({ sourceChecksum: sourceHash, recipe });
    return withIdentityLock(identity, async () => {
      const existing = await pool.query(`SELECT d.*,a.content_hash,a.media_type,s.status AS storage_status FROM media_derivatives d JOIN artifacts a ON a.id=d.artifact_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE d.identity=$1`, [identity]);
      if (existing.rows[0]?.storage_status === 'READY' && existing.rows[0].content_hash && existing.rows[0].status === 'READY') return { artifactId, identity, recipeHash, cacheHit: true, sourceArtifactId };
      const sourceAccess = await gateway.resolve({ artifactId: sourceArtifactId, actor: job.worker_id || process.env.FORGE_WORKER_ID || 'worker', action: 'download', purpose: 'worker' });
      const sourceMeta = sourceAccess.artifact;
      if (sourceMeta.project_id !== job.project_id || sourceMeta.episode_id !== job.episode_id) throw Object.assign(new Error('Derivative source is outside the job tenant/project scope'), { code: 'FORBIDDEN', retryable: false });
      if (sourceMeta.content_hash !== sourceHash) throw Object.assign(new Error('Source checksum changed during derivative admission'), { code: 'SOURCE_CHANGED', retryable: false });
      const dir = await fsp.mkdtemp(path.join(workDir, `${identity.slice(0, 16)}-`));
      const inputPath = path.join(dir, 'source.bin'); const outputSpecInfo = outputSpec(recipe); const outputPath = path.join(dir, `output.${outputSpecInfo.ext}`);
      try {
        const opened = await gateway.open({ artifactId: sourceArtifactId, actor: job.worker_id || process.env.FORGE_WORKER_ID || 'worker', purpose: 'worker' });
        await boundedDownload(opened.stream, inputPath, maxInputBytes, () => cancelled(job.id));
        const downloadedHash = await sha256File(inputPath);
        if (downloadedHash !== sourceHash) throw Object.assign(new Error('Downloaded source checksum mismatch'), { code: 'SOURCE_CORRUPT', retryable: false });
        const probed = validateMediaMetadata(await ffprobeJson(inputPath, { ffprobePath }), { maxDurationSeconds: limits.maxDurationSeconds || MAX_DURATION_SECONDS });
        if (recipe.type === 'waveform' && !probed.streams.some((s) => s.codec_type === 'audio')) throw Object.assign(new Error('Waveform requires an audio stream'), { code: 'MEDIA_UNSUPPORTED', retryable: false });
        if (['poster','contact-sheet','proxy','clip'].includes(recipe.type) && !probed.streams.some((s) => s.codec_type === 'video')) throw Object.assign(new Error('Video derivative requires a video stream'), { code: 'MEDIA_UNSUPPORTED', retryable: false });
        if (recipe.type === 'poster' && recipe.timestampSeconds > probed.durationSeconds) throw Object.assign(new Error('Poster timestamp exceeds media duration'), { code: 'INVALID_RECIPE', retryable: false });
        await runProcess(ffmpegPath, ffmpegArgs(recipe, inputPath, outputPath, probed.durationSeconds), { cwd: dir, timeoutMs, onTick: () => cancelled(job.id) ? 'cancel' : undefined });
        const outputStat = await fsp.stat(outputPath);
        if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > maxOutputBytes) throw Object.assign(new Error('Derivative output violates size limit'), { code: 'OUTPUT_LIMIT', retryable: false });
        const outputHash = await sha256File(outputPath);
        const outputMeta = await ffprobeJson(outputPath, { ffprobePath });
        if (!Array.isArray(outputMeta.streams) || !outputMeta.streams.length) throw Object.assign(new Error('Derivative output metadata is invalid'), { code: 'OUTPUT_INVALID', retryable: false });
        const artifact = await artifactStore.putArtifact({ episodeId: sourceMeta.episode_id, projectId: sourceMeta.project_id, versionId: sourceMeta.version_id, kind: `derivative:${recipe.type}`, stream: fs.createReadStream(outputPath), contentType: outputSpecInfo.mediaType, expectedSha256: outputHash, artifactId, createdBy: job.worker_id || 'worker', inputVersionIds: [sourceMeta.version_id], source: 'forge-derivative', metadata: { derivativeIdentity: identity, sourceArtifactId, sourceChecksum: sourceHash, recipe, recipeHash, outputChecksum: outputHash, sourceDurationSeconds: probed.durationSeconds, outputSizeBytes: outputStat.size, outputMetadata: outputMeta } });
        const tenantRow = await pool.query('SELECT tenant_id FROM projects WHERE id=$1', [sourceMeta.project_id]);
        const tenantId = tenantRow.rows[0]?.tenant_id;
        if (!tenantId) throw Object.assign(new Error('Derivative project has no tenant scope'), { code: 'TENANT_SCOPE_MISSING', retryable: false });
        const validation = await validator.validateArtifact({ tenantId, projectId: sourceMeta.project_id, episodeId: sourceMeta.episode_id, artifact: { id: artifact.id, versionId: artifact.versionId, contentHash: outputHash, storageUri: artifact.storageUri, mediaType: outputSpecInfo.mediaType, metadata: artifact.metadata || {} }, payload: { expectedMedia: payload.expectedMedia || {} }, timeoutMs });
        if (!['PASSED','WARNINGS','OVERRIDDEN'].includes(validation.status)) {
          await pool.query(`INSERT INTO media_derivatives(identity,source_artifact_id,artifact_id,project_id,episode_id,source_checksum,recipe_hash,recipe,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'QUARANTINED',$9) ON CONFLICT(identity) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,status='QUARANTINED',updated_at=now()`, [identity, sourceArtifactId, artifact.id, sourceMeta.project_id, sourceMeta.episode_id, sourceHash, recipeHash, JSON.stringify(recipe), job.worker_id || 'worker']);
          throw Object.assign(new Error(`Derivative media validation ${validation.status.toLowerCase()}`), { code: 'MEDIA_VALIDATION_BLOCKED', retryable: false, validationId: validation.id });
        }
        await pool.query(`INSERT INTO media_derivatives(identity,source_artifact_id,artifact_id,project_id,episode_id,source_checksum,recipe_hash,recipe,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'READY',$9) ON CONFLICT(identity) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,status='READY',updated_at=now()`, [identity, sourceArtifactId, artifact.id, sourceMeta.project_id, sourceMeta.episode_id, sourceHash, recipeHash, JSON.stringify(recipe), job.worker_id || 'worker']);
        await pool.query(`INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,'MEDIA_DERIVATIVE_GENERATED','artifact',$4,$5::jsonb)`, [sourceMeta.project_id, sourceMeta.episode_id, job.worker_id || 'worker', artifact.id, JSON.stringify({ sourceArtifactId, identity, recipe, sourceChecksum: sourceHash, outputChecksum: outputHash, validationId: validation.id, validationStatus: validation.status })]);
        return { artifactId: artifact.id, identity, recipeHash, sourceArtifactId, sourceChecksum: sourceHash, outputChecksum: outputHash, bytes: outputStat.size, mediaType: outputSpecInfo.mediaType, cacheHit: false, validationId: validation.id, validationStatus: validation.status };
      } catch (error) {
        if (error.code === 'JOB_CANCELLED') throw error;
        logger.error?.({ event: 'media_derivative.failed', jobId: job.id, sourceArtifactId, recipe, error: { message: error.message, code: error.code } });
        throw error;
      } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
    });
  };
}

module.exports = { createMediaDerivativeHandler, validateMediaMetadata, ffmpegArgs, ffprobeJson, runProcess, boundedDownload, SAFE_CODEC, SAFE_FORMAT };