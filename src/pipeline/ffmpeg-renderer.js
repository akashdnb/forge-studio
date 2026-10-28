'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { motionFilter } = require('./camera-motion-profile');

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SOURCE_PATTERN = /^[A-Za-z0-9._~:/@+%=-]+$/;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

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
  const video = normalized.timeline.tracks.find((track) => track.type === 'VIDEO');
  if (!video || !video.segments?.length) throw Object.assign(new Error('render requires at least one VIDEO segment'), { retryable: false });
  for (const track of normalized.timeline.tracks) {
    for (const segment of track.segments || []) {
      if (!segment.id || !Number.isFinite(Number(segment.start)) || !Number.isFinite(Number(segment.duration)) || Number(segment.duration) <= 0) {
        throw Object.assign(new Error(`invalid timeline segment: ${segment.id || 'unknown'}`), { retryable: false });
      }
      const source = segment.sourcePath || segment.path;
      if (!source || typeof source !== 'string' || path.isAbsolute(source) || source.includes('..')) {
        throw Object.assign(new Error(`segment ${segment.id} requires a safe relative sourcePath`), { retryable: false });
      }
      if (!SOURCE_PATTERN.test(source)) throw Object.assign(new Error(`segment ${segment.id} has an invalid sourcePath`), { retryable: false });
    }
  }
  const duration = Number(normalized.timeline.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('timeline durationSeconds must be positive');
  return Object.freeze({ ...normalized, durationSeconds: duration, manifest });
}

function run(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { retryable: true }));
    }, timeoutMs);
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
  const inputs = [];
  const filters = [];
  const concatLabels = [];
  let nextInput = 0;
  let cursor = 0;

  const addVideo = (index, label, duration, shotSpec) => {
    filters.push(motionFilter(shotSpec, index, label, duration, VIDEO_WIDTH, VIDEO_HEIGHT));
  };

  for (const [index, segment] of videoSegments.entries()) {
    const start = Number(segment.start);
    const duration = Number(segment.duration);
    const gap = start - cursor;
    if (gap > 0.001) {
      inputs.push('-f', 'lavfi', '-t', String(gap), '-i', `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${VIDEO_FPS}`);
      addVideo(nextInput, `gap${index}`, gap, null);
      concatLabels.push(`[gap${index}]`);
      nextInput += 1;
    }
    const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
    inputs.push('-stream_loop', '-1', '-i', source);
    addVideo(nextInput, `v${index}`, duration, segment.shotSpec);
    concatLabels.push(`[v${index}]`);
    nextInput += 1;
    cursor = Math.max(cursor, start + duration);
  }

  const tail = input.durationSeconds - cursor;
  if (tail > 0.001) {
    inputs.push('-f', 'lavfi', '-t', String(tail), '-i', `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${VIDEO_FPS}`);
    addVideo(nextInput, 'tail', tail, null);
    concatLabels.push('[tail]');
    nextInput += 1;
  }

  filters.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[vout]`);

  const audioLabels = [];
  for (const track of audioTracks) {
    for (const segment of track.segments || []) {
      const source = path.resolve(input.workDir, segment.sourcePath || segment.path);
      inputs.push('-stream_loop', '-1', '-i', source);
      const label = `a${audioLabels.length}`;
      const delay = Math.max(0, Math.round(Number(segment.start) * 1000));
      filters.push(`[${nextInput}:a]atrim=duration=${Number(segment.duration)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,aresample=48000,volume=1[${label}]`);
      audioLabels.push(`[${label}]`);
      nextInput += 1;
    }
  }

  if (audioLabels.length) {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${input.durationSeconds},aresample=48000[aout]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${input.durationSeconds}[aout]`);
  }

  return [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', String(input.durationSeconds),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(VIDEO_FPS),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-y', outputPath,
  ];
}

async function renderTimeline({ input, workDir, outputPath, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const immutable = validateRenderInput({ ...input, workDir });
  const sources = immutable.timeline.tracks.flatMap((track) => track.segments || []).map((segment) => path.resolve(workDir, segment.sourcePath || segment.path));
  try {
    await Promise.all(sources.map((source) => fs.access(source)));
  } catch (error) {
    throw Object.assign(new Error(`Render source file is missing: ${error.path || error.message}`), { retryable: false });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await run(ffmpegPath, buildFfmpegArgs(immutable, outputPath), { cwd: workDir, timeoutMs });
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
  };
  await fs.writeFile(`${outputPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { outputPath, checksum, sizeBytes: stat.size, metadata };
}

module.exports = { renderTimeline, validateRenderInput, buildFfmpegArgs, sha256Json, sha256File, VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS };
