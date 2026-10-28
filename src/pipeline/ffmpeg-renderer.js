const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SOURCE_PATTERN = /^[A-Za-z0-9._~:/@+%=-]+$/;
const RENDER_MEDIA_TRACKS = new Set(['VIDEO', 'NARRATION', 'MUSIC', 'SFX']);

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

function sha256Json(v) {
  return crypto.createHash('sha256').update(stableJson(v)).digest('hex');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = require('node:fs').createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.once('error', reject);
    s.once('end', () => resolve(h.digest('hex')));
  });
}

function validateRenderInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('render input is required');
  const manifest = input.manifest;
  let normalized = input;
  if (manifest) {
    if (manifest.manifestKind !== 'render-manifest' || !manifest.manifestChecksum || !Array.isArray(manifest.tracks)) {
      throw Object.assign(new Error('invalid render manifest'), { retryable: false });
    }
    const { manifestChecksum, ...base } = manifest;
    if (sha256Json(base) !== manifestChecksum) throw Object.assign(new Error('render manifest checksum mismatch'), { retryable: false });
    normalized = {
      ...input,
      timeline: { tracks: manifest.tracks, durationSeconds: manifest.durationSeconds },
      timelineVersionId: manifest.timelineVersionId,
      timelineContentHash: manifest.timelineContentHash,
      inputVersionIds: manifest.inputVersionIds || [],
    };
  }
  if (!normalized.timeline || !Array.isArray(normalized.timeline.tracks)) throw new TypeError('render input timeline is required');
  if (!normalized.timelineVersionId || !normalized.timelineContentHash) throw new TypeError('immutable timeline identity is required');
  if (!manifest && sha256Json(normalized.timeline) !== normalized.timelineContentHash) {
    throw Object.assign(new Error('timeline content hash mismatch'), { retryable: false });
  }
  const video = normalized.timeline.tracks.find((t) => t.type === 'VIDEO');
  if (!video || !video.segments?.length) throw Object.assign(new Error('render requires at least one VIDEO segment'), { retryable: false });
  const duration = Number(normalized.timeline.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('timeline durationSeconds must be positive'), { retryable: false });

  for (const track of normalized.timeline.tracks) {
    for (const segment of track.segments || []) {
      if (!segment.id || !Number.isFinite(Number(segment.start)) || !Number.isFinite(Number(segment.duration)) || Number(segment.duration) <= 0) {
        throw Object.assign(new Error(`invalid timeline segment: ${segment.id || 'unknown'}`), { retryable: false });
      }
      const start = Number(segment.start);
      const end = start + Number(segment.duration);
      if (start < 0 || end > duration + 0.001) {
        throw Object.assign(new Error(`timeline segment ${segment.id} falls outside the render duration`), { retryable: false });
      }
      if (track.type === 'CAPTIONS') {
        if (typeof segment.text !== 'string' || !segment.text.trim()) {
          throw Object.assign(new Error(`caption segment ${segment.id} requires non-empty text`), { retryable: false });
        }
        continue;
      }
      if (!RENDER_MEDIA_TRACKS.has(track.type)) continue;
      const source = segment.sourcePath || segment.path;
      if (!source || typeof source !== 'string' || path.isAbsolute(source) || source.includes('..')) {
        throw Object.assign(new Error(`segment ${segment.id} requires a safe relative sourcePath`), { retryable: false });
      }
      if (!SOURCE_PATTERN.test(source)) throw Object.assign(new Error(`segment ${segment.id} has an invalid sourcePath`), { retryable: false });
    }
  }
  return Object.freeze({ ...normalized, durationSeconds: duration, manifest });
}

function run(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { retryable: true }));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`${command} unavailable: ${e.message}`), { retryable: true })); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`), { retryable: false, stdout, stderr }));
    });
  });
}

function escapeSrtText(text) {
  return String(text).replace(/\r?\n/gu, ' ').trim();
}

function formatSrtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function buildCaptionSrt(track, durationSeconds) {
  const segments = [...(track?.segments || [])].sort((a, b) => Number(a.start) - Number(b.start) || String(a.id).localeCompare(String(b.id)));
  let previousEnd = 0;
  const lines = [];
  segments.forEach((segment, index) => {
    const start = Number(segment.start);
    const end = start + Number(segment.duration);
    if (start < previousEnd - 0.001 || end > durationSeconds + 0.001) {
      throw Object.assign(new Error(`caption segment ${segment.id} has invalid timing`), { retryable: false });
    }
    lines.push(String(index + 1), `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`, escapeSrtText(segment.text), '');
    previousEnd = end;
  });
  return lines.join('\n');
}

function escapeFilterFilename(filePath) {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildFfmpegArgs(input, outputPath, { captionPath = null } = {}) {
  const videoTrack = input.timeline.tracks.find((t) => t.type === 'VIDEO');
  const audioTracks = input.timeline.tracks.filter((t) => RENDER_MEDIA_TRACKS.has(t.type) && t.type !== 'VIDEO');
  const videoSegments = [...videoTrack.segments].sort((a, b) => Number(a.start) - Number(b.start));
  const inputs = [], filters = [], concatLabels = [];
  let nextInput = 0;
  let cursor = 0;

  const addVideo = (i, label, d) => filters.push(`[${i}:v]scale=w='round(iw*min(${VIDEO_WIDTH}/(iw*sar),${VIDEO_HEIGHT}/ih))':h='round(ih*min(${VIDEO_WIDTH}/(iw*sar),${VIDEO_HEIGHT}/ih))',pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${VIDEO_FPS},trim=duration=${d},setpts=PTS-STARTPTS[${label}]`);
  for (const [index, segment] of videoSegments.entries()) {
    const start = Number(segment.start), duration = Number(segment.duration), gap = start - cursor;
    if (gap > 0.001) {
      inputs.push('-f', 'lavfi', '-t', String(gap), '-i', `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${VIDEO_FPS}`);
      addVideo(nextInput, `gap${index}`, gap);
      concatLabels.push(`[gap${index}]`);
      nextInput++;
    }
    const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
    inputs.push('-stream_loop', '-1', '-i', source);
    addVideo(nextInput, `v${index}`, duration);
    concatLabels.push(`[v${index}]`);
    nextInput++;
    cursor = Math.max(cursor, start + duration);
  }
  const tail = input.durationSeconds - cursor;
  if (tail > 0.001) {
    inputs.push('-f', 'lavfi', '-t', String(tail), '-i', `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${VIDEO_FPS}`);
    addVideo(nextInput, 'tail', tail);
    concatLabels.push('[tail]');
    nextInput++;
  }
  const videoBase = captionPath ? 'vbase' : 'vout';
  filters.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[${videoBase}]`);
  if (captionPath) filters.push(`[${videoBase}]subtitles=filename='${escapeFilterFilename(captionPath)}'[vout]`);

  const audioLabels = [];
  for (const track of audioTracks) for (const segment of track.segments || []) {
    const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
    inputs.push('-stream_loop', '-1', '-i', source);
    const label = `a${audioLabels.length}`;
    const delay = Math.max(0, Math.round(Number(segment.start) * 1000));
    filters.push(`[${nextInput}:a]atrim=duration=${Number(segment.duration)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,aresample=48000,volume=1[${label}]`);
    audioLabels.push(`[${label}]`);
    nextInput++;
  }
  if (audioLabels.length) filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${input.durationSeconds},aresample=48000[aout]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${input.durationSeconds}[aout]`);

  return [...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(input.durationSeconds), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-map_metadata', '-1', '-y', outputPath];
}

async function renderTimeline({ input, workDir, outputPath, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const immutable = validateRenderInput({ ...input, workDir });
  const sources = immutable.timeline.tracks
    .filter((track) => RENDER_MEDIA_TRACKS.has(track.type))
    .flatMap((track) => track.segments || [])
    .map((s) => path.resolve(workDir, s.sourcePath || s.path));
  try { await Promise.all(sources.map((s) => fs.access(s))); }
  catch (error) { throw Object.assign(new Error(`Render source file is missing: ${error.path || error.message}`), { retryable: false }); }

  const captionTrack = immutable.timeline.tracks.find((track) => track.type === 'CAPTIONS');
  const captionPath = captionTrack ? path.join(workDir, `.forge-captions-${sha256Json(captionTrack)}.srt`) : null;
  if (captionTrack) await fs.writeFile(captionPath, buildCaptionSrt(captionTrack, immutable.durationSeconds), 'utf8');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await run(ffmpegPath, buildFfmpegArgs(immutable, outputPath, { captionPath }), { cwd: workDir, timeoutMs });
  } finally {
    if (captionPath) await fs.rm(captionPath, { force: true });
  }
  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) throw Object.assign(new Error('ffmpeg completed without a non-empty MP4'), { retryable: false });
  const checksum = await sha256File(outputPath);
  const metadata = {
    schemaVersion: 'forge-render-v2',
    mediaType: 'video/mp4',
    sizeBytes: stat.size,
    sha256: checksum,
    timelineVersionId: immutable.timelineVersionId,
    timelineContentHash: immutable.timelineContentHash,
    inputVersionIds: [...(immutable.inputVersionIds || [])],
    durationSeconds: immutable.durationSeconds,
    manifestChecksum: immutable.manifest?.manifestChecksum || null,
    captionCueCount: captionTrack?.segments?.length || 0,
  };
  await fs.writeFile(`${outputPath}.json`, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  return { outputPath, checksum, sizeBytes: stat.size, metadata };
}

module.exports = { renderTimeline, validateRenderInput, buildFfmpegArgs, sha256Json, sha256File, VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS, buildCaptionSrt };
