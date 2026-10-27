'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { materializeMedia, sha256File, validateMediaArtifact } = require('./media-qa');

const VARIANTS = Object.freeze({
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1080, height: 1080 },
});
const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 'forge-video-finishing-v1',
  variants: ['16:9', '9:16', '1:1'],
  captionMode: 'none',
  captionPath: null,
  titleCard: null,
  lowerThirds: [],
  branding: null,
  intro: null,
  outro: null,
  thumbnail: true,
  black: { minDurationSeconds: 1.0, pixelThreshold: 0.10, pictureBlackThreshold: 0.98 },
  frozen: { minDurationSeconds: 2.0 },
  durationToleranceSeconds: 0.5,
  fps: 30,
});

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function sha256Json(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function finite(value, fallback = null) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function safeText(value) { return String(value ?? '').replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,'); }
function normalizeConfig(input = {}) {
  const config = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, ...input }));
  config.variants = [...new Set((input.variants || DEFAULT_CONFIG.variants).map(String))];
  if (!config.variants.length || config.variants.some((v) => !VARIANTS[v])) throw new TypeError('variants must contain only 16:9, 9:16 or 1:1');
  if (!['none', 'burn-in', 'sidecar'].includes(config.captionMode)) throw new TypeError('captionMode must be none, burn-in or sidecar');
  if (config.captionMode !== 'none' && !config.captionPath) throw new TypeError('captionPath is required when captions are enabled');
  config.fps = finite(config.fps, 30);
  if (config.fps <= 0 || config.fps > 120) throw new TypeError('fps must be between 0 and 120');
  config.durationToleranceSeconds = finite(config.durationToleranceSeconds, 0.5);
  return config;
}
function run(command, args, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`${command} timed out`), { code: 'FINISHING_TIMEOUT', retryable: true })); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr }); else reject(Object.assign(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`), { code: 'FINISHING_FFMPEG_FAILED', retryable: false, stdout, stderr })); });
  });
}
function aspectFilter(width, height, fps) {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`;
}
function buildVideoFilter(config, variant) {
  const { width, height } = VARIANTS[variant];
  const filters = [aspectFilter(width, height, config.fps)];
  if (config.titleCard?.text) {
    const seconds = finite(config.titleCard.durationSeconds, 2);
    filters.push(`drawtext=text='${safeText(config.titleCard.text)}':fontcolor=${safeText(config.titleCard.color || 'white')}:fontsize=${finite(config.titleCard.fontSize, Math.round(Math.min(width, height) * 0.06))}:x=(w-text_w)/2:y=(h-text_h)/2:enable='lt(t,${seconds})'`);
  }
  for (const lower of config.lowerThirds || []) {
    const start = finite(lower.startSeconds, 0), end = finite(lower.endSeconds, Number.MAX_SAFE_INTEGER);
    filters.push(`drawtext=text='${safeText(lower.text)}':fontcolor=${safeText(lower.color || 'white')}:fontsize=${finite(lower.fontSize, Math.max(24, Math.round(Math.min(width, height) * 0.035)))}:x=${finite(lower.x, width * 0.06)}:y=${finite(lower.y, height * 0.82)}:enable='between(t,${start},${end})'`);
  }
  if (config.branding?.text) {
    filters.push(`drawtext=text='${safeText(config.branding.text)}':fontcolor=${safeText(config.branding.color || 'white')}:fontsize=${finite(config.branding.fontSize, Math.max(18, Math.round(Math.min(width, height) * 0.025)))}:x=w-text_w-${finite(config.branding.margin, Math.round(width * 0.03))}:y=h-text_h-${finite(config.branding.margin, Math.round(height * 0.03))}`);
  }
  return filters.join(',');
}
function buildFinishingArgs({ inputPath, outputPath, config, variant }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath];
  const filters = [buildVideoFilter(config, variant)];
  if (config.captionMode === 'burn-in') filters.push(`subtitles='${String(config.captionPath).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`);
  args.push('-vf', filters.join(','), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(config.fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-map_metadata', '-1', '-metadata', `forge_finishing_config_sha256=${sha256Json(config)}`, '-metadata', `forge_finishing_variant=${variant}`, '-f', 'mp4', outputPath);
  return args;
}
function buildThumbnailArgs({ inputPath, outputPath, width = 1280 }) {
  return ['-hide_banner', '-nostdin', '-y', '-ss', '0.5', '-i', inputPath, '-frames:v', '1', '-vf', `scale=${width}:-2:force_original_aspect_ratio=decrease`, '-q:v', '2', outputPath];
}
function parseDetectorOutput(stderr, type) {
  const pattern = type === 'black' ? /black_start:([\d.]+).*?black_end:([\d.]+).*?black_duration:([\d.]+)/g : /freeze_start:([\d.]+).*?freeze_end:([\d.]+).*?freeze_duration:([\d.]+)/g;
  const events = []; let match;
  while ((match = pattern.exec(stderr))) events.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  return events;
}
async function inspectActualMedia(filePath, { ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', expectedDurationSeconds = null, width, height, fps = 30, black = DEFAULT_CONFIG.black, frozen = DEFAULT_CONFIG.frozen } = {}) {
  const artifact = { kind: 'render', storageUri: `file://${filePath}`, metadata: { expectedMedia: { durationSeconds: expectedDurationSeconds, durationToleranceSeconds: 0.5, width, height, videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2 } } };
  const media = await validateMediaArtifact({ artifact, ffprobePath, ffmpegPath });
  const checks = [...media.checks];
  let detection;
  try {
    detection = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', filePath, '-vf', `blackdetect=d=${black.minDurationSeconds}:pix_th=${black.pixelThreshold}:pic_th=${black.pictureBlackThreshold},freezedetect=n=-60dB:d=${frozen.minDurationSeconds}`, '-an', '-f', 'null', '-']);
  } catch (error) {
    detection = error;
    checks.push({ name: 'visual_integrity', status: 'FAIL', message: 'Visual black/frozen-frame analysis failed', details: { stderr: error.stderr?.slice(-8000) || error.message } });
  }
  if (detection && detection.stderr) {
    const blackEvents = parseDetectorOutput(detection.stderr, 'black');
    const frozenEvents = parseDetectorOutput(detection.stderr, 'frozen');
    checks.push({ name: 'black_frames', status: blackEvents.length ? 'FAIL' : 'PASS', message: blackEvents.length ? 'Actual rendered media contains black-frame intervals' : 'No black-frame interval exceeded the configured threshold', details: { events: blackEvents } });
    checks.push({ name: 'frozen_frames', status: frozenEvents.length ? 'FAIL' : 'PASS', message: frozenEvents.length ? 'Actual rendered media contains frozen-frame intervals' : 'No frozen-frame interval exceeded the configured threshold', details: { events: frozenEvents } });
  }
  return { ...media, status: checks.some((c) => c.status === 'FAIL') ? 'FAILED' : checks.some((c) => c.status === 'WARN') ? 'WARNINGS' : 'PASSED', checks, detector: detection?.stderr ? { black: parseDetectorOutput(detection.stderr, 'black'), frozen: parseDetectorOutput(detection.stderr, 'frozen') } : null, fps };
}
function parseCaptionFile(text, filePath) {
  const source = String(text).replace(/^\uFEFF/, '');
  const cues = [];
  if (/\.vtt$/i.test(filePath) || source.startsWith('WEBVTT')) {
    for (const block of source.split(/\r?\n\r?\n/)) {
      const m = block.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
      if (m) cues.push({ start: timecode(m[1]), end: timecode(m[2]) });
    }
  } else {
    for (const m of source.matchAll(/\d+\s*\r?\n(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})/g)) cues.push({ start: timecode(m[1]), end: timecode(m[2]) });
  }
  return cues;
}
function timecode(value) { const [h, m, s] = value.replace(',', '.').split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); }
async function validateSubtitleSync(captionPath, durationSeconds) {
  const cues = parseCaptionFile(await fsp.readFile(captionPath, 'utf8'), captionPath);
  const checks = [];
  let previousEnd = 0;
  for (const [index, cue] of cues.entries()) {
    const valid = cue.start >= 0 && cue.end > cue.start && cue.start >= previousEnd - 0.001 && cue.end <= durationSeconds + 0.5;
    checks.push({ name: `subtitle_${index + 1}`, status: valid ? 'PASS' : 'FAIL', message: valid ? 'Subtitle cue is monotonic and within rendered duration' : 'Subtitle cue is invalid or outside rendered duration', details: cue });
    previousEnd = Math.max(previousEnd, cue.end);
  }
  if (!cues.length) checks.push({ name: 'subtitle_presence', status: 'FAIL', message: 'Caption file contains no parseable cues', details: {} });
  return { status: checks.some((c) => c.status === 'FAIL') ? 'FAILED' : 'PASSED', checks, cueCount: cues.length };
}
async function copyToStorage(storage, localPath, { tenantId, projectId, kind, contentType }) {
  const stream = fs.createReadStream(localPath);
  return storage.upload({ stream, tenantId, projectId, kind, contentType });
}
async function persistFinishing({ pool, episodeId, renderArtifactId, inputVersionId, config, variants, thumbnail, actor = 'video-finisher' }) {
  const configHash = sha256Json(config);
  const versionId = `video-finish-${configHash.slice(0, 24)}`;
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,parent_id,payload,content_hash,created_by) VALUES($1,$2,'render',$3,$4::jsonb,$5,$6) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,content_hash=EXCLUDED.content_hash`, [versionId, episodeId, inputVersionId || null, JSON.stringify({ schemaVersion: 'forge-video-finishing-v1', config, configHash }), configHash, actor]);
  const artifactRows = [];
  for (const item of variants) {
    const artifactId = `finish-${configHash.slice(0, 16)}-${item.variant.replace(':', 'x')}`;
    const row = await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'render',$3,$4,$5,'video/mp4','forge', $6::jsonb,$7::jsonb,$8) ON CONFLICT(id) DO UPDATE SET storage_uri=EXCLUDED.storage_uri,content_hash=EXCLUDED.content_hash,metadata=EXCLUDED.metadata RETURNING *`, [artifactId, episodeId, versionId, item.storageUri, item.checksum, JSON.stringify([inputVersionId].filter(Boolean)), JSON.stringify({ finishingConfigHash: configHash, variant: item.variant, provenance: { sourceRenderArtifactId: renderArtifactId } }), actor]);
    artifactRows.push(row.rows[0]);
  }
  if (thumbnail) artifactRows.push((await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'thumbnail',$3,$4,$5,$6,'forge',$7::jsonb,$8::jsonb,$9) ON CONFLICT(id) DO UPDATE SET storage_uri=EXCLUDED.storage_uri,content_hash=EXCLUDED.content_hash,metadata=EXCLUDED.metadata RETURNING *`, [`thumb-${configHash.slice(0, 24)}`, episodeId, versionId, thumbnail.storageUri, thumbnail.checksum, thumbnail.contentType, JSON.stringify([inputVersionId].filter(Boolean)), JSON.stringify({ finishingConfigHash: configHash }), actor])).rows[0]);
  return { versionId, configHash, artifactRows };
}
async function finishVideo({ pool, storage, payload, actor = 'video-finisher', ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe' }) {
  if (!pool || !storage) throw new TypeError('pool and storage are required');
  const config = normalizeConfig(payload.finishingConfig || {});
  const configHash = sha256Json(config);
  const render = payload.renderArtifact;
  if (!render?.storageUri) throw Object.assign(new Error('renderArtifact.storageUri is required'), { code: 'INVALID_FINISH_INPUT', retryable: false });
  const expectedDuration = finite(payload.expectedDurationSeconds, finite(render.metadata?.durationSeconds, null));
  const materialized = await materializeMedia(render.storageUri, { timeoutMs: 15 * 60 * 1000, maxBytes: 10 * 1024 * 1024 * 1024, allowedHosts: payload.allowedHosts || [] });
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-finish-'));
  const outputs = [];
  try {
    let captionQa = null;
    if (config.captionMode !== 'none') captionQa = await validateSubtitleSync(config.captionPath, expectedDuration || Number.MAX_SAFE_INTEGER);
    if (captionQa?.status === 'FAILED') throw Object.assign(new Error('Subtitle sync validation failed'), { code: 'SUBTITLE_SYNC_FAILED', retryable: false, evidence: captionQa });
    for (const variant of config.variants) {
      const outputPath = path.join(workDir, `final-${variant.replace(':', 'x')}.mp4`);
      const expected = VARIANTS[variant];
      await run(ffmpegPath, buildFinishingArgs({ inputPath: materialized.path, outputPath, config, variant }));
      const qa = await inspectActualMedia(outputPath, { ffmpegPath, ffprobePath, expectedDurationSeconds: expectedDuration, width: expected.width, height: expected.height, fps: config.fps, black: config.black, frozen: config.frozen });
      if (qa.status === 'FAILED') throw Object.assign(new Error(`Final ${variant} render failed ship QA`), { code: 'FINAL_QA_FAILED', retryable: false, evidence: qa });
      const uploaded = await copyToStorage(storage, outputPath, { tenantId: payload.tenantId || 'default', projectId: payload.projectId, kind: `final-${variant.replace(':', 'x')}`, contentType: 'video/mp4' });
      outputs.push({ variant, ...uploaded, checksum: uploaded.sha256, qa });
    }
    let thumbnail = null;
    if (config.thumbnail) {
      const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
      await run(ffmpegPath, buildThumbnailArgs({ inputPath: path.join(workDir, 'final-16x9.mp4'), outputPath: thumbnailPath }));
      const uploaded = await copyToStorage(storage, thumbnailPath, { tenantId: payload.tenantId || 'default', projectId: payload.projectId, kind: 'thumbnail', contentType: 'image/jpeg' });
      thumbnail = { ...uploaded, checksum: uploaded.sha256, contentType: 'image/jpeg' };
    }
    const persisted = await persistFinishing({ pool, episodeId: payload.episodeId, renderArtifactId: render.id, inputVersionId: payload.inputVersionId || render.versionId || null, config, variants: outputs, thumbnail, actor });
    const checks = outputs.flatMap((item) => item.qa.checks.map((check) => ({ ...check, variant: item.variant })));
    if (captionQa) checks.push(...captionQa.checks);
    const finalStatus = checks.some((c) => c.status === 'FAIL') ? 'FAILED' : 'PASSED';
    const gateStatus = finalStatus === 'PASSED' && outputs.length === config.variants.length ? 'READY_TO_SHIP' : 'BLOCKED';
    const qaId = `final-qa-${configHash.slice(0, 24)}`;
    await pool.query(`INSERT INTO qa_results(id,episode_id,artifact_id,version_id,status,checks,runner,metadata,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,'video-finishing',$7::jsonb,$1) ON CONFLICT(idempotency_key) DO UPDATE SET status=EXCLUDED.status,checks=EXCLUDED.checks,metadata=EXCLUDED.metadata`, [qaId, payload.episodeId, outputs[0].id || persisted.artifactRows[0].id, persisted.versionId, finalStatus, JSON.stringify(checks), JSON.stringify({ schemaVersion: 'forge-final-qa-v1', gateStatus, finishingConfigHash: configHash, artifactRefs: outputs.map((o) => ({ variant: o.variant, storageUri: o.uri, checksum: o.checksum })), thumbnail: thumbnail ? { storageUri: thumbnail.uri, checksum: thumbnail.checksum } : null, provenance: { inputRenderArtifactId: render.id, inputVersionId: payload.inputVersionId || render.versionId || null } }) ]);
    if (gateStatus !== 'READY_TO_SHIP') throw Object.assign(new Error('Final QA did not produce READY_TO_SHIP'), { code: 'FINAL_QA_FAILED', retryable: false });
    await pool.query(`UPDATE episodes SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{finalShipGate}',$1::jsonb,true),updated_at=now() WHERE id=$2`, [JSON.stringify({ status: 'READY_TO_SHIP', qaId, versionId: persisted.versionId, configHash, artifactIds: persisted.artifactRows.map((a) => a.id) }), payload.episodeId]);
    return { status: 'READY_TO_SHIP', qaId, versionId: persisted.versionId, configHash, variants: outputs.map((o) => ({ variant: o.variant, storageUri: o.uri, checksum: o.checksum, qa: o.qa.status })), thumbnail: thumbnail ? { storageUri: thumbnail.uri, checksum: thumbnail.checksum } : null };
  } finally { await materialized.cleanup(); await fsp.rm(workDir, { recursive: true, force: true }); }
}

function createVideoFinishingHandler({ pool, storage }) { return async (payload, job = {}) => finishVideo({ pool, storage, payload, actor: payload.actor || job.worker_id || 'video-finisher' }); }

module.exports = { VARIANTS, normalizeConfig, stableJson, sha256Json, buildVideoFilter, buildFinishingArgs, buildThumbnailArgs, parseCaptionFile, validateSubtitleSync, inspectActualMedia, persistFinishing, finishVideo, createVideoFinishingHandler };
