'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { materializeMedia, sha256File } = require('./media-qa');

const SCHEMA_VERSION = 'forge-media-validation-v1';
const DEFAULT_POLICY = Object.freeze({
  maxBytes: 5 * 1024 * 1024 * 1024,
  maxDurationSeconds: 3600,
  maxWidth: 16384,
  maxHeight: 16384,
  minWidth: 1,
  minHeight: 1,
  maxFps: 120,
  minFps: 1,
  maxAspectRatio: 4,
  minAspectRatio: 0.25,
  durationToleranceSeconds: 0.5,
  avDurationToleranceSeconds: 0.75,
  maxStreams: 8,
  maxSubtitleCues: 10000,
  maxSubtitleCueDurationSeconds: 7200,
  requireVideo: false,
  requireAudio: false,
  requireCompleteDecode: true,
  allowSubtitleStreams: true,
  allowDataStreams: false,
  allowedMimeTypes: ['video/mp4','video/webm','video/quicktime','video/x-matroska','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/flac','image/png','image/jpeg','image/webp'],
  allowedContainers: ['mov','mp4','m4a','3gp','3g2','mj2','matroska','webm','mp3','wav','ogg','flac','image2','png_pipe','jpeg_pipe','webp_pipe'],
  allowedCodecs: ['h264','hevc','vp8','vp9','av1','mpeg4','mjpeg','png','webp','aac','mp3','opus','vorbis','flac','pcm_s16le','pcm_s24le','pcm_s32le','alaw','mulaw'],
  allowedFrameRates: null,
  failClosed: true,
  quarantineOnFailure: true,
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function fingerprint(value) { return sha256(value); }
function diagnostic(code, message, details = {}, severity = 'FAIL') { return { code, message, severity, details, deterministic: true }; }
function statusFor(diagnostics) { if (diagnostics.some((d) => d.severity === 'FAIL')) return 'FAILED'; if (diagnostics.some((d) => d.severity === 'WARN')) return 'WARNINGS'; return 'PASSED'; }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function fps(value) { if (!value) return null; const [a,b] = String(value).split('/').map(Number); if (Number.isFinite(a) && Number.isFinite(b) && b) return a / b; return finite(value); }
function mediaClass(mime) { if (String(mime).startsWith('video/')) return 'video'; if (String(mime).startsWith('audio/')) return 'audio'; if (String(mime).startsWith('image/')) return 'image'; return null; }

function parseSubtitleCues(input, format = null) {
  if (input == null) return { cues: [], diagnostics: [] };
  const text = typeof input === 'string' ? input : String(input.text || input.content || '');
  const detected = format || (text.trimStart().startsWith('WEBVTT') ? 'vtt' : 'srt');
  const diagnostics = [];
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map((v) => v.trim()).filter(Boolean);
  const time = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})/;
  for (let index = 0; index < blocks.length; index += 1) {
    const lines = blocks[index].split('\n');
    if (detected === 'vtt' && index === 0 && lines[0] === 'WEBVTT') continue;
    const timingIndex = lines.findIndex((line) => time.test(line));
    if (timingIndex < 0) { diagnostics.push(diagnostic('SUBTITLE_TIMING_INVALID', `Subtitle cue ${index + 1} has no valid timing line`, { cue: index + 1 })); continue; }
    const match = lines[timingIndex].match(time);
    const start = ((Number(match[1] || 0) * 3600) + Number(match[2]) * 60 + Number(match[3])) + Number(match[4]) / 1000;
    const end = ((Number(match[5] || 0) * 3600) + Number(match[6]) * 60 + Number(match[7])) + Number(match[8]) / 1000;
    const body = lines.slice(timingIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (end <= start) diagnostics.push(diagnostic('SUBTITLE_TIMING_ORDER', `Subtitle cue ${index + 1} ends before or at its start`, { cue: index + 1, start, end }));
    if (!body) diagnostics.push(diagnostic('SUBTITLE_TEXT_EMPTY', `Subtitle cue ${index + 1} has no text`, { cue: index + 1 }));
    cues.push({ index: index + 1, start, end, text: body });
  }
  for (let i = 1; i < cues.length; i += 1) if (cues[i].start < cues[i - 1].end) diagnostics.push(diagnostic('SUBTITLE_OVERLAP', `Subtitle cues ${cues[i - 1].index} and ${cues[i].index} overlap`, { previous: cues[i - 1].index, current: cues[i].index }));
  return { cues, diagnostics };
}

function validateProbe(probe, { mimeType, sizeBytes, policy = DEFAULT_POLICY, expected = {} } = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const diagnostics = [];
  const type = mediaClass(mimeType);
  const formatName = String(probe?.format?.format_name || '').split(',')[0] || null;
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const duration = finite(probe?.format?.duration);
  if (!type || !p.allowedMimeTypes.includes(mimeType)) diagnostics.push(diagnostic('MIME_UNSUPPORTED', `Unsupported MIME type: ${mimeType}`, { mimeType }));
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > p.maxBytes) diagnostics.push(diagnostic('SIZE_LIMIT', 'Media exceeds the configured size limit', { sizeBytes, maxBytes: p.maxBytes }));
  if (!probe?.format || !streams.length) diagnostics.push(diagnostic('CONTAINER_UNREADABLE', 'Media container or stream metadata is unavailable'));
  if (formatName && !p.allowedContainers.includes(formatName)) diagnostics.push(diagnostic('CONTAINER_UNSUPPORTED', `Unsupported container: ${formatName}`, { formatName }));
  if (duration == null || duration < 0 || duration > p.maxDurationSeconds) diagnostics.push(diagnostic('DURATION_INVALID', 'Media duration is invalid or exceeds policy', { duration, maxDurationSeconds: p.maxDurationSeconds }));
  if (streams.length > p.maxStreams) diagnostics.push(diagnostic('STREAM_COUNT_LIMIT', 'Media contains too many streams', { count: streams.length, maxStreams: p.maxStreams }));
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subtitle = streams.filter((s) => s.codec_type === 'subtitle');
  const unsupported = streams.filter((s) => !['video','audio','subtitle','attachment','data'].includes(s.codec_type));
  if (p.requireVideo && !video.length) diagnostics.push(diagnostic('VIDEO_REQUIRED', 'Policy requires a video stream'));
  if (p.requireAudio && !audio.length) diagnostics.push(diagnostic('AUDIO_REQUIRED', 'Policy requires an audio stream'));
  if (!p.allowSubtitleStreams && subtitle.length) diagnostics.push(diagnostic('SUBTITLE_STREAM_UNSUPPORTED', 'Subtitle streams are not allowed by policy'));
  if (!p.allowDataStreams && (unsupported.length || streams.some((s) => ['attachment','data'].includes(s.codec_type)))) diagnostics.push(diagnostic('UNSUPPORTED_STREAM', 'Media contains unsupported data or attachment streams', { streamTypes: streams.map((s) => s.codec_type) }));
  for (const stream of streams) {
    if (stream.codec_name && !p.allowedCodecs.includes(stream.codec_name)) diagnostics.push(diagnostic('CODEC_UNSUPPORTED', `Unsupported codec: ${stream.codec_name}`, { codec: stream.codec_name, streamIndex: stream.index }));
    if (stream.codec_type === 'video') {
      const width = finite(stream.width), height = finite(stream.height), rate = fps(stream.avg_frame_rate || stream.r_frame_rate);
      if (width == null || height == null || width < p.minWidth || height < p.minHeight || width > p.maxWidth || height > p.maxHeight) diagnostics.push(diagnostic('RESOLUTION_INVALID', 'Video resolution violates policy', { width, height, minWidth: p.minWidth, minHeight: p.minHeight, maxWidth: p.maxWidth, maxHeight: p.maxHeight, streamIndex: stream.index }));
      const aspect = height ? width / height : null;
      if (aspect != null && (aspect < p.minAspectRatio || aspect > p.maxAspectRatio)) diagnostics.push(diagnostic('ASPECT_RATIO_INVALID', 'Video aspect ratio violates policy', { aspect, min: p.minAspectRatio, max: p.maxAspectRatio }));
      if (rate != null && (rate < p.minFps || rate > p.maxFps)) diagnostics.push(diagnostic('FRAME_RATE_INVALID', 'Frame rate violates policy', { fps: rate, minFps: p.minFps, maxFps: p.maxFps }));
      if (Array.isArray(p.allowedFrameRates) && p.allowedFrameRates.length && rate != null && !p.allowedFrameRates.some((allowed) => Math.abs(rate - Number(allowed)) < 0.001)) diagnostics.push(diagnostic('FRAME_RATE_UNSUPPORTED', 'Frame rate is not in the policy allowlist', { fps: rate, allowedFrameRates: p.allowedFrameRates }));
    }
    if (stream.codec_type === 'audio') {
      const sampleRate = finite(stream.sample_rate), channels = finite(stream.channels);
      if (p.maxAudioSampleRate && sampleRate > p.maxAudioSampleRate) diagnostics.push(diagnostic('AUDIO_SAMPLE_RATE_INVALID', 'Audio sample rate exceeds policy', { sampleRate, maxAudioSampleRate: p.maxAudioSampleRate }));
      if (p.allowedAudioChannels && p.allowedAudioChannels.length && !p.allowedAudioChannels.includes(channels)) diagnostics.push(diagnostic('AUDIO_CHANNELS_INVALID', 'Audio channel count is not allowed', { channels, allowedAudioChannels: p.allowedAudioChannels }));
    }
  }
  if (type === 'video' && !video.length) diagnostics.push(diagnostic('MEDIA_TYPE_MISMATCH', 'Video MIME type has no video stream'));
  if (type === 'audio' && !audio.length) diagnostics.push(diagnostic('MEDIA_TYPE_MISMATCH', 'Audio MIME type has no audio stream'));
  if (type === 'image' && video.length && duration != null && duration > 0) diagnostics.push(diagnostic('IMAGE_STREAM_INVALID', 'Image media exposes a timed video stream unexpectedly'));
  if (expected.durationSeconds != null && duration != null && Math.abs(duration - Number(expected.durationSeconds)) > Number(expected.durationToleranceSeconds ?? p.durationToleranceSeconds)) diagnostics.push(diagnostic('DURATION_MISMATCH', 'Duration does not match expected timeline metadata', { actual: duration, expected: Number(expected.durationSeconds), tolerance: Number(expected.durationToleranceSeconds ?? p.durationToleranceSeconds) }));
  const durations = streams.map((s) => finite(s.duration)).filter((n) => n != null);
  if (durations.length > 1 && Math.max(...durations) - Math.min(...durations) > p.avDurationToleranceSeconds) diagnostics.push(diagnostic('AV_DURATION_MISMATCH', 'Audio/video stream durations diverge beyond tolerance', { durations, tolerance: p.avDurationToleranceSeconds }));
  const metadata = { format: formatName, durationSeconds: duration, streams: streams.map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, width: s.width || null, height: s.height || null, fps: fps(s.avg_frame_rate || s.r_frame_rate), sampleRate: s.sample_rate || null, channels: s.channels || null, duration: finite(s.duration) })) };
  return { status: statusFor(diagnostics), diagnostics: diagnostics.sort((a,b) => a.code.localeCompare(b.code)), metadata };
}

function run(command, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error(`${command} timed out`), { code: 'MEDIA_VALIDATION_TIMEOUT', retryable: true })); }, timeoutMs);
    timer.unref?.();
    const abort = () => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('Media validation cancelled'), { code: 'MEDIA_VALIDATION_CANCELLED', retryable: false })); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 8 * 1024 * 1024) stderr = stderr.slice(-8 * 1024 * 1024); });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, sig) => code === 0 ? finish(resolve, { stdout, stderr }) : finish(reject, Object.assign(new Error(`${command} failed with exit ${code}`), { code: 'MEDIA_CORRUPT', retryable: false, stderr: stderr.slice(-8000), signal: sig })));
  });
}

async function validateFile(filePath, { mimeType, sizeBytes, policy, expected = {}, ffprobePath = process.env.FORGE_FFPROBE_PATH || 'ffprobe', ffmpegPath = process.env.FORGE_FFMPEG_PATH || 'ffmpeg', timeoutMs = 600000, signal, subtitleContent = null } = {}) {
  let probe = null; const diagnostics = [];
  const hash = await sha256File(filePath, policy.maxBytes);
  try {
    const probeRun = await run(ffprobePath, ['-v','error','-print_format','json','-show_error','-show_format','-show_streams','-bitexact',filePath], { timeoutMs, signal });
    try { probe = JSON.parse(probeRun.stdout); } catch { diagnostics.push(diagnostic('PROBE_JSON_INVALID', 'ffprobe returned invalid JSON')); }
  } catch (error) { diagnostics.push(diagnostic(error.code === 'MEDIA_CORRUPT' ? 'CONTAINER_CORRUPT' : (error.code || 'PROBE_FAILED'), error.message, { stderr: error.stderr || null }, error.retryable ? 'WARN' : 'FAIL')); }
  if (probe) {
    const checked = validateProbe(probe, { mimeType, sizeBytes, policy, expected });
    diagnostics.push(...checked.diagnostics);
    if (policy.requireCompleteDecode && checked.status !== 'FAILED') {
      try { await run(ffmpegPath, ['-hide_banner','-nostdin','-v','error','-xerror','-err_detect','explode','-i',filePath,'-map','0:v:0?','-map','0:a:0?','-map','0:s:0?','-f','null','-'], { timeoutMs, signal }); }
      catch (error) { diagnostics.push(diagnostic('DECODE_INTEGRITY_FAILED', 'FFmpeg detected corruption, truncation, or undecodable media', { code: error.code, stderr: error.stderr || null })); }
    }
  }
  if (subtitleContent != null) {
    const parsed = parseSubtitleCues(subtitleContent);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.cues.length > policy.maxSubtitleCues) diagnostics.push(diagnostic('SUBTITLE_CUE_LIMIT', 'Subtitle cue count exceeds policy', { count: parsed.cues.length, max: policy.maxSubtitleCues }));
    if (parsed.cues.some((cue) => cue.end - cue.start > policy.maxSubtitleCueDurationSeconds)) diagnostics.push(diagnostic('SUBTITLE_CUE_DURATION', 'Subtitle cue duration exceeds policy'));
    if (probe?.format?.duration != null && parsed.cues.some((cue) => cue.end > Number(probe.format.duration) + policy.durationToleranceSeconds)) diagnostics.push(diagnostic('SUBTITLE_OUT_OF_RANGE', 'Subtitle cue extends beyond media duration'));
  }
  const metadata = probe ? validateProbe(probe, { mimeType, sizeBytes, policy, expected }).metadata : {};
  const sorted = diagnostics.sort((a,b) => `${a.code}:${a.message}`.localeCompare(`${b.code}:${b.message}`));
  const result = { schemaVersion: SCHEMA_VERSION, status: statusFor(sorted), diagnostics: sorted, metadata, checksum: hash.hash, sizeBytes: hash.sizeBytes, deterministic: true };
  result.fingerprint = fingerprint({ schemaVersion: SCHEMA_VERSION, checksum: result.checksum, status: result.status, diagnostics: result.diagnostics, metadata: result.metadata });
  return result;
}

class MediaValidationService {
  constructor({ pool, workerId = 'media-validator', logger = console, maxConcurrency = 2, now = () => new Date() } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pool is required');
    this.pool = pool; this.workerId = workerId; this.logger = logger; this.maxConcurrency = Math.max(1, Math.min(8, Number(maxConcurrency) || 2)); this.now = now;
  }
  async policyFor({ tenantId, projectId, versionId, policyOverride = null }) {
    if (policyOverride) { const policy = { ...DEFAULT_POLICY, ...policyOverride }; return { id: `snapshot:${fingerprint(policy)}`, version: 0, policy, fingerprint: fingerprint(policy) }; }
    const query = await this.pool.query(`SELECT * FROM media_validation_policies WHERE active AND ((version_id=$1) OR (version_id IS NULL AND project_id=$2) OR (version_id IS NULL AND project_id IS NULL AND tenant_id=$3)) ORDER BY CASE WHEN version_id=$1 THEN 1 WHEN project_id=$2 THEN 2 ELSE 3 END, policy_version DESC, created_at DESC LIMIT 1`, [versionId, projectId, tenantId]);
    if (!query.rows[0]) return { id: `default:${fingerprint(DEFAULT_POLICY)}`, version: 0, policy: { ...DEFAULT_POLICY }, fingerprint: fingerprint(DEFAULT_POLICY) };
    const row = query.rows[0]; return { id: row.id, version: row.policy_version, policy: { ...DEFAULT_POLICY, ...(row.policy || {}) }, fingerprint: row.policy_fingerprint };
  }
  async begin({ tenantId, projectId, episodeId = null, artifactId, versionId, contentHash, policy }) {
    const id = `validation:${artifactId}:${versionId}:${policy.fingerprint}`;
    const fingerprintValue = fingerprint({ artifactId, versionId, contentHash, policyFingerprint: policy.fingerprint });
    const result = await this.pool.query(`INSERT INTO media_validation_records(id,tenant_id,project_id,episode_id,artifact_id,version_id,content_hash,policy_id,policy_fingerprint,status,fingerprint,worker_id,lease_token,lease_expires_at,attempts,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RUNNING',$10,$11,$12,now()+interval '15 minutes',1,now()) ON CONFLICT(tenant_id,project_id,artifact_id,version_id,content_hash,policy_fingerprint) DO UPDATE SET status='RUNNING',worker_id=EXCLUDED.worker_id,lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,attempts=media_validation_records.attempts+1,started_at=now() RETURNING *`, [id, tenantId, projectId, episodeId, artifactId, versionId, contentHash, policy.id, policy.fingerprint, fingerprintValue, this.workerId, crypto.randomUUID()]);
    return result.rows[0];
  }
  async complete({ id, status, diagnostics, metadata, evidenceHash = null, overrideId = null }) {
    return (await this.pool.query(`UPDATE media_validation_records SET status=$2,diagnostics=$3::jsonb,media_metadata=$4::jsonb,evidence_hash=$5,override_id=$6,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [id, status, JSON.stringify(diagnostics), JSON.stringify(metadata || {}), evidenceHash, overrideId])).rows[0];
  }
  async validateArtifact({ tenantId, projectId, episodeId = null, artifact, payload = {}, policyOverride = null, signal, ffprobePath, ffmpegPath, timeoutMs = 600000 }) {
    if (!artifact?.id || !artifact.versionId || !artifact.contentHash || !artifact.storageUri) throw Object.assign(new Error('Media artifact lacks immutable identity or storage reference'), { code: 'MEDIA_VALIDATION_INPUT_INVALID', retryable: false });
    const policy = await this.policyFor({ tenantId, projectId, versionId: artifact.versionId, policyOverride });
    const existing = await this.pool.query(`SELECT * FROM media_validation_records WHERE tenant_id=$1 AND project_id=$2 AND artifact_id=$3 AND version_id=$4 AND content_hash=$5 AND policy_fingerprint=$6 ORDER BY created_at DESC LIMIT 1`, [tenantId, projectId, artifact.id, artifact.versionId, artifact.contentHash, policy.fingerprint]);
    if (existing.rows[0] && ['PASSED','WARNINGS','OVERRIDDEN'].includes(existing.rows[0].status)) return { ...existing.rows[0], cacheHit: true, policy };
    const record = await this.begin({ tenantId, projectId, episodeId, artifactId: artifact.id, versionId: artifact.versionId, contentHash: artifact.contentHash, policy });
    let materialized;
    try {
      materialized = await materializeMedia(artifact.storageUri, { timeoutMs, maxBytes: policy.policy.maxBytes, allowedHosts: String(process.env.FORGE_QA_ALLOWED_MEDIA_HOSTS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean) });
      const result = await validateFile(materialized.path, { mimeType: artifact.mediaType, sizeBytes: materialized.sizeBytes, policy: policy.policy, expected: payload.expectedMedia || payload.metadata?.expectedMedia || {}, ffprobePath, ffmpegPath, timeoutMs, signal, subtitleContent: payload.subtitleContent || payload.captions || null });
      const finalStatus = result.status === 'FAILED' && policy.policy.quarantineOnFailure ? 'QUARANTINED' : result.status;
      const evidenceHash = fingerprint({ recordId: record.id, policyFingerprint: policy.fingerprint, result: { status: finalStatus, diagnostics: result.diagnostics, metadata: result.metadata, checksum: result.checksum } });
      const completed = await this.complete({ id: record.id, status: finalStatus, diagnostics: result.diagnostics, metadata: { ...result.metadata, checksum: result.checksum, sizeBytes: result.sizeBytes, policySnapshot: policy.policy, policyVersion: policy.version }, evidenceHash });
      if (finalStatus === 'QUARANTINED') await this.pool.query(`INSERT INTO media_quarantine(id,tenant_id,project_id,artifact_id,version_id,validation_id,reason_code,diagnostics,remediation) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`, [`quarantine:${record.id}`, tenantId, projectId, artifact.id, artifact.versionId, record.id, result.diagnostics[0]?.code || 'MEDIA_POLICY_FAILED', JSON.stringify(result.diagnostics), 'Replace or remediate the media, then rerun validation.']);
      return { ...completed, result, policy };
    } catch (error) {
      const status = error.code === 'MEDIA_VALIDATION_CANCELLED' ? 'CANCELLED' : (policy.policy.quarantineOnFailure ? 'QUARANTINED' : 'FAILED');
      const diag = [diagnostic(error.code || 'MEDIA_VALIDATION_FAILED', error.message, { retryable: error.retryable === true }, error.retryable ? 'WARN' : 'FAIL')];
      const completed = await this.complete({ id: record.id, status, diagnostics: diag, metadata: {}, evidenceHash: fingerprint({ recordId: record.id, policyFingerprint: policy.fingerprint, diagnostics: diag }) });
      if (status === 'QUARANTINED') await this.pool.query(`INSERT INTO media_quarantine(id,tenant_id,project_id,artifact_id,version_id,validation_id,reason_code,diagnostics,remediation) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`, [`quarantine:${record.id}`, tenantId, projectId, artifact.id, artifact.versionId, record.id, error.code || 'MEDIA_VALIDATION_FAILED', JSON.stringify(diag), 'Replace or remediate the media, then rerun validation.']);
      return completed;
    } finally { await materialized?.cleanup?.(); }
  }
  async validateMany(items, { signal, concurrency = this.maxConcurrency } = {}) {
    const results = new Array(items.length); let next = 0;
    const worker = async () => { while (true) { if (signal?.aborted) return; const index = next++; if (index >= items.length) return; try { results[index] = await this.validateArtifact({ ...items[index], signal }); } catch (error) { results[index] = { status: 'FAILED', error: { code: error.code, message: error.message } }; } } };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)); return results;
  }
  async recoverStale(limit = 50) {
    const result = await this.pool.query(`UPDATE media_validation_records SET status='STALE',lease_expires_at=NULL,updated_at=now() WHERE status IN ('RUNNING','PENDING') AND lease_expires_at IS NOT NULL AND lease_expires_at < now() RETURNING id`, []); return { recovered: Math.min(result.rowCount || 0, limit) };
  }
  async assertPublishable({ tenantId, projectId, artifactId, versionId }) {
    const result = await this.pool.query(`SELECT v.* FROM media_validation_records v WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.artifact_id=$3 AND v.version_id=$4 ORDER BY v.created_at DESC LIMIT 1`, [tenantId, projectId, artifactId, versionId]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error('No media validation record exists for publish artifact'), { code: 'MEDIA_VALIDATION_REQUIRED', retryable: false });
    if (!['PASSED','WARNINGS','OVERRIDDEN'].includes(row.status)) throw Object.assign(new Error(`Media validation blocks publish: ${row.status}`), { code: 'MEDIA_VALIDATION_BLOCKED', retryable: false, details: { validationId: row.id, status: row.status } });
    return row;
  }
  async approveOverride({ tenantId, projectId, artifactId, versionId, validationId, reason, evidence = {}, approvedBy, expiresAt = null }) {
    if (!reason || !approvedBy) throw Object.assign(new Error('Override reason and approver are required'), { code: 'OVERRIDE_INVALID', retryable: false });
    const evidenceHash = fingerprint({ tenantId, projectId, artifactId, versionId, validationId, reason, evidence, approvedBy, expiresAt });
    const id = `media-override:${evidenceHash}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const check = await client.query('SELECT * FROM media_validation_records WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND artifact_id=$4 AND version_id=$5 FOR UPDATE', [validationId, tenantId, projectId, artifactId, versionId]);
      if (!check.rows[0]) throw Object.assign(new Error('Validation record not found in tenant/project scope'), { code: 'NOT_FOUND', retryable: false });
      await client.query(`INSERT INTO media_validation_overrides(id,tenant_id,project_id,artifact_id,version_id,validation_id,reason,evidence,evidence_hash,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) ON CONFLICT(id) DO NOTHING`, [id, tenantId, projectId, artifactId, versionId, validationId, reason, JSON.stringify(evidence), evidenceHash, approvedBy, expiresAt]);
      const updated = await client.query(`UPDATE media_validation_records SET status='OVERRIDDEN',override_id=$1,updated_at=now() WHERE id=$2 RETURNING *`, [id, validationId]);
      await client.query('COMMIT'); return updated.rows[0];
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
}

function createMediaValidationHandler({ pool, storage = null, workerId = 'media-validator', logger = console, maxConcurrency = 2 } = {}) {
  const service = new MediaValidationService({ pool, workerId, logger, maxConcurrency });
  return async (payload, job) => {
    const artifactId = payload?.artifactId || payload?.renderArtifactId || payload?.derivativeArtifactId;
    if (!artifactId) throw Object.assign(new Error('Media validation job requires artifactId'), { code: 'INVALID_INPUT', retryable: false });
    const row = (await pool.query(`SELECT a.*,e.project_id,pr.tenant_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects pr ON pr.id=e.project_id WHERE a.id=$1 AND e.project_id=$2`, [artifactId, job.project_id])).rows[0];
    if (!row) throw Object.assign(new Error('Media artifact is outside the job project scope'), { code: 'FORBIDDEN', retryable: false });
    const result = await service.validateArtifact({ tenantId: row.tenant_id, projectId: row.project_id, episodeId: row.episode_id, artifact: { id: row.id, versionId: row.version_id, contentHash: row.content_hash, storageUri: row.storage_uri, mediaType: row.media_type, metadata: row.metadata || {} }, payload, timeoutMs: Number(process.env.FORGE_MEDIA_VALIDATION_TIMEOUT_MS || 600000) });
    if (!['PASSED','WARNINGS','OVERRIDDEN'].includes(result.status)) { const error = Object.assign(new Error(`Media validation ${result.status.toLowerCase()}`), { code: 'MEDIA_VALIDATION_BLOCKED', retryable: false }); error.validationId = result.id; throw error; }
    return { stage: 'MEDIA_VALIDATION', artifactId: row.id, versionId: row.version_id, validationId: result.id, status: result.status, metadata: result.media_metadata || result.result?.metadata || {} };
  };
}

module.exports = { SCHEMA_VERSION, DEFAULT_POLICY, stable, fingerprint, diagnostic, statusFor, parseSubtitleCues, validateProbe, validateFile, MediaValidationService, createMediaValidationHandler };
