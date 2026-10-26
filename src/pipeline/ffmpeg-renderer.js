const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SOURCE_PATTERN = /^[A-Za-z0-9._~:/@+%=-]+$/;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function sha256Json(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = require('node:fs').createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function validateRenderInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('render input is required');
  if (!input.timeline || !Array.isArray(input.timeline.tracks)) throw new TypeError('render input timeline is required');
  if (!input.timelineVersionId || !input.timelineContentHash) throw new TypeError('immutable timeline identity is required');
  if (sha256Json(input.timeline) !== input.timelineContentHash) throw Object.assign(new Error('timeline content hash mismatch'), { retryable: false });
  const video = input.timeline.tracks.find((track) => track.type === 'VIDEO');
  if (!video || !video.segments?.length) throw Object.assign(new Error('render requires at least one VIDEO segment'), { retryable: false });
  for (const track of input.timeline.tracks) for (const segment of track.segments || []) {
    if (!segment.id || !Number.isFinite(Number(segment.start)) || !Number.isFinite(Number(segment.duration)) || Number(segment.duration) <= 0) throw Object.assign(new Error(`invalid timeline segment: ${segment.id || 'unknown'}`), { retryable: false });
    const source = segment.sourcePath || segment.path;
    if (!source || typeof source !== 'string' || path.isAbsolute(source) || source.includes('..')) throw Object.assign(new Error(`segment ${segment.id} requires a safe relative sourcePath`), { retryable: false });
    if (!SOURCE_PATTERN.test(source)) throw Object.assign(new Error(`segment ${segment.id} has an invalid sourcePath`), { retryable: false });
  }
  const duration = Number(input.timeline.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('timeline durationSeconds must be positive'), { retryable: false });
  return Object.freeze({ ...input, durationSeconds: duration });
}

function run(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { retryable: true })); }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`), { retryable: false, stdout, stderr }));
    });
  });
}

function buildFfmpegArgs(input, outputPath) {
  const videoTrack = input.timeline.tracks.find((track) => track.type === 'VIDEO');
  const audioTracks = input.timeline.tracks.filter((track) => ['NARRATION', 'MUSIC', 'SFX'].includes(track.type));
  const videoSegments = [...videoTrack.segments].sort((a, b) => Number(a.start) - Number(b.start));
  const inputs = []; const filters = []; const concatLabels = [];
  for (const [index, segment] of videoSegments.entries()) {
    const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
    inputs.push('-stream_loop', '-1', '-i', source);
    const label = `v${index}`;
    filters.push(`[${index}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${VIDEO_FPS},trim=duration=${Number(segment.duration)},setpts=PTS-STARTPTS[${label}]`);
    concatLabels.push(`[${label}]`);
  }
  filters.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[vout]`);
  let nextInput = videoSegments.length; const audioLabels = [];
  for (const track of audioTracks) for (const segment of track.segments || []) {
    const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
    inputs.push('-stream_loop', '-1', '-i', source);
    const label = `a${audioLabels.length}`; const delay = Math.max(0, Math.round(Number(segment.start) * 1000));
    filters.push(`[${nextInput}:a]atrim=duration=${Number(segment.duration)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,aresample=48000,volume=1[${label}]`);
    audioLabels.push(`[${label}]`); nextInput += 1;
  }
  if (audioLabels.length) filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${input.durationSeconds},aresample=48000[aout]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${input.durationSeconds}[aout]`);
  return [...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(input.durationSeconds), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-map_metadata', '-1', '-y', outputPath];
}

async function renderTimeline({ input, workDir, outputPath, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const immutable = validateRenderInput({ ...input, workDir });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await run(ffmpegPath, buildFfmpegArgs(immutable, outputPath), { cwd: workDir, timeoutMs });
  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) throw Object.assign(new Error('ffmpeg completed without a non-empty MP4'), { retryable: false });
  const checksum = await sha256File(outputPath);
  const metadata = {
    schemaVersion: 'forge-render-v1', mediaType: 'video/mp4', sizeBytes: stat.size, sha256: checksum,
    timelineVersionId: immutable.timelineVersionId, timelineContentHash: immutable.timelineContentHash,
    inputVersionIds: [...(immutable.inputVersionIds || [])], durationSeconds: immutable.durationSeconds,
  };
  await fs.writeFile(`${outputPath}.json`, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  return { outputPath, checksum, sizeBytes: stat.size, metadata };
}

module.exports = { renderTimeline, validateRenderInput, buildFfmpegArgs, sha256Json, sha256File, VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS };
