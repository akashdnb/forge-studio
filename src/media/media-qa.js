const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const net = require('node:net');

const MP4_FORMATS = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DURATION_TOLERANCE = 0.5;

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseExpectedMetadata(metadata = {}) {
  const expected = metadata.expectedMedia || metadata.mediaQa || metadata.qa || {};
  return {
    durationSeconds: finite(expected.durationSeconds ?? expected.expectedDurationSeconds),
    durationToleranceSeconds: finite(expected.durationToleranceSeconds, DEFAULT_DURATION_TOLERANCE),
    videoCodec: expected.videoCodec || expected.expectedVideoCodec || null,
    audioCodec: expected.audioCodec || expected.expectedAudioCodec || null,
    width: finite(expected.width),
    height: finite(expected.height),
    audioSampleRate: finite(expected.audioSampleRate),
    audioChannels: finite(expected.audioChannels),
    format: expected.format || 'mp4',
    requireVideo: expected.requireVideo !== false,
    requireAudio: expected.requireAudio !== false,
  };
}

function makeCheck(name, status, message, details = {}) {
  return { name, status, message, details };
}

function resultStatus(checks) {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAILED';
  if (checks.some((c) => c.status === 'WARN')) return 'WARNINGS';
  return 'PASSED';
}

function runCommand(command, args, { timeoutMs, maxOutputBytes = 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) return target;
      return target + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: 'MEDIA_QA_TIMEOUT', retryable: true }));
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function assertHttpHostAllowed(url, allowedHosts) {
  if (!allowedHosts.length) throw Object.assign(new Error('HTTP media URI rejected: FORGE_QA_ALLOWED_MEDIA_HOSTS is not configured'), { code: 'MEDIA_QA_HOST_NOT_ALLOWED' });
  const host = url.hostname.toLowerCase();
  if (allowedHosts.includes(host)) return;
  const addresses = await dns.lookup(host, { all: true });
  for (const entry of addresses) {
    const address = entry.address;
    if (net.isIP(address) && (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address) || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:'))) {
      throw Object.assign(new Error('HTTP media URI resolves to a private/link-local address'), { code: 'MEDIA_QA_SSRF_BLOCKED' });
    }
  }
  throw Object.assign(new Error(`HTTP media host is not allowlisted: ${host}`), { code: 'MEDIA_QA_HOST_NOT_ALLOWED' });
}

async function downloadHttp(url, destination, { timeoutMs, maxBytes, allowedHosts }) {
  await assertHttpHostAllowed(url, allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.body) throw Object.assign(new Error(`Media download returned HTTP ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Media object exceeds ${maxBytes} byte limit`);
    const file = fs.createWriteStream(destination, { flags: 'wx' });
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw Object.assign(new Error(`Media object exceeds ${maxBytes} byte limit`), { code: 'MEDIA_QA_SIZE_LIMIT' });
        if (!file.write(chunk)) await new Promise((resolve, reject) => { file.once('drain', resolve); file.once('error', reject); });
      }
      await new Promise((resolve, reject) => { file.end((error) => error ? reject(error) : resolve()); });
    } catch (error) {
      file.destroy();
      throw error;
    }
    return { sizeBytes: total };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error(`Media download timed out after ${timeoutMs}ms`), { code: 'MEDIA_QA_TIMEOUT', retryable: true });
    throw error;
  } finally { clearTimeout(timer); }
}

async function materializeMedia(storageUri, options) {
  const uri = new URL(storageUri);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-media-qa-'));
  const destination = path.join(tempDir, 'artifact.mp4');
  try {
    if (uri.protocol === 'file:') {
      if (uri.hostname && uri.hostname !== 'localhost') throw new Error('file URI hostname is not supported');
      const source = decodeURIComponent(uri.pathname);
      const stat = await fsp.stat(source);
      if (!stat.isFile()) throw new Error('Media storage URI is not a regular file');
      if (stat.size > options.maxBytes) throw Object.assign(new Error(`Media object exceeds ${options.maxBytes} byte limit`), { code: 'MEDIA_QA_SIZE_LIMIT' });
      await fsp.copyFile(source, destination);
      return { path: destination, sizeBytes: stat.size, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
    }
    if (uri.protocol === 'http:' || uri.protocol === 'https:') {
      const downloaded = await downloadHttp(uri, destination, options);
      return { path: destination, sizeBytes: downloaded.sizeBytes, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
    }
    if (uri.protocol === 's3:') {
      let S3Client;
      let GetObjectCommand;
      try { ({ S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')); }
      catch { throw Object.assign(new Error('S3 media URI requires @aws-sdk/client-s3'), { retryable: false }); }
      const bucket = uri.hostname;
      const key = decodeURIComponent(uri.pathname.slice(1));
      if (!bucket || !key) throw new Error('Invalid s3:// storage URI');
      const client = new S3Client({
        region: process.env.FORGE_S3_REGION || process.env.AWS_REGION || 'us-east-1',
        endpoint: process.env.FORGE_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL,
        forcePathStyle: process.env.FORGE_S3_FORCE_PATH_STYLE === 'true',
      });
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error('S3 object returned no body');
      const length = Number(response.ContentLength);
      if (Number.isFinite(length) && length > options.maxBytes) throw Object.assign(new Error(`Media object exceeds ${options.maxBytes} byte limit`), { code: 'MEDIA_QA_SIZE_LIMIT' });
      const file = fs.createWriteStream(destination, { flags: 'wx' });
      let total = 0;
      for await (const chunk of response.Body) {
        total += chunk.length;
        if (total > options.maxBytes) throw Object.assign(new Error(`Media object exceeds ${options.maxBytes} byte limit`), { code: 'MEDIA_QA_SIZE_LIMIT' });
        if (!file.write(chunk)) await new Promise((resolve, reject) => { file.once('drain', resolve); file.once('error', reject); });
      }
      await new Promise((resolve, reject) => { file.end((error) => error ? reject(error) : resolve()); });
      return { path: destination, sizeBytes: total, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
    }
    throw new Error(`Unsupported media storage URI protocol: ${uri.protocol}`);
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function sha256File(filePath, maxBytes) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`Media object exceeds ${maxBytes} byte limit`), { code: 'MEDIA_QA_SIZE_LIMIT' });
    hash.update(chunk);
  }
  return { hash: hash.digest('hex'), sizeBytes: size };
}

function expectedInput(payload = {}, artifact = {}) {
  return {
    ...parseExpectedMetadata(artifact.metadata || {}),
    ...parseExpectedMetadata(payload.timelineMetadata || payload.metadata || {}),
  };
}

async function validateMediaArtifact({ artifact, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg', allowedHosts = [] }) {
  if (!artifact || artifact.kind !== 'render') throw Object.assign(new Error('Media QA requires a render artifact'), { retryable: false });
  if (!artifact.storageUri) throw Object.assign(new Error('Render artifact has no storageUri'), { retryable: false });
  const expected = expectedInput(payload, artifact);
  const checks = [];
  let materialized;
  let probe = null;
  let checksum = null;
  const startedAt = Date.now();
  try {
    materialized = await materializeMedia(artifact.storageUri, { timeoutMs, maxBytes, allowedHosts });
    checksum = await sha256File(materialized.path, maxBytes);
    checks.push(makeCheck('checksum', artifact.contentHash ? (checksum.hash === artifact.contentHash ? 'PASS' : 'FAIL') : 'WARN', artifact.contentHash ? (checksum.hash === artifact.contentHash ? 'SHA-256 matches artifact provenance' : 'SHA-256 does not match artifact provenance') : 'Artifact has no expected SHA-256 checksum', { expected: artifact.contentHash || null, actual: checksum.hash, sizeBytes: checksum.sizeBytes }));

    const probeRun = await runCommand(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_error', '-show_format', '-show_streams', '-bitexact', materialized.path], { timeoutMs });
    if (probeRun.code !== 0) {
      checks.push(makeCheck('container', 'FAIL', 'ffprobe could not parse the media container', { stderr: probeRun.stderr.slice(-4000), exitCode: probeRun.code }));
      return buildResult(checks, probe, checksum, expected, startedAt, materialized.sizeBytes);
    }
    try { probe = JSON.parse(probeRun.stdout); } catch { checks.push(makeCheck('container', 'FAIL', 'ffprobe returned invalid JSON')); return buildResult(checks, probe, checksum, expected, startedAt, materialized.sizeBytes); }
    const formatName = String(probe.format?.format_name || '').split(',')[0];
    const containerPass = MP4_FORMATS.has(formatName);
    checks.push(makeCheck('container', containerPass ? 'PASS' : 'FAIL', containerPass ? `Container format ${formatName} is MP4-compatible` : `Unexpected container format: ${formatName || 'unknown'}`, { formatName, formatLongName: probe.format?.format_long_name || null }));

    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    checks.push(makeCheck('stream_presence', video && audio ? 'PASS' : 'FAIL', video && audio ? 'Required video and audio streams are present' : 'Required video and audio streams are not both present', { video: Boolean(video), audio: Boolean(audio) }));
    checks.push(makeCheck('video_codec', video && (!expected.videoCodec || video.codec_name === expected.videoCodec) ? 'PASS' : 'FAIL', video ? `Video codec is ${video.codec_name}` : 'Video stream is missing', { actual: video?.codec_name || null, expected: expected.videoCodec }));
    checks.push(makeCheck('audio_codec', audio && (!expected.audioCodec || audio.codec_name === expected.audioCodec) ? 'PASS' : 'FAIL', audio ? `Audio codec is ${audio.codec_name}` : 'Audio stream is missing', { actual: audio?.codec_name || null, expected: expected.audioCodec }));

    const duration = finite(probe.format?.duration);
    const tolerance = expected.durationToleranceSeconds ?? DEFAULT_DURATION_TOLERANCE;
    const durationPass = duration != null && (expected.durationSeconds == null || Math.abs(duration - expected.durationSeconds) <= tolerance);
    checks.push(makeCheck('duration', durationPass ? 'PASS' : 'FAIL', durationPass ? 'Duration matches the expected timeline within tolerance' : 'Duration is missing or outside the expected timeline tolerance', { actualSeconds: duration, expectedSeconds: expected.durationSeconds, toleranceSeconds: tolerance }));
    if (video) {
      const dimensionsPass = (!expected.width || Number(video.width) === expected.width) && (!expected.height || Number(video.height) === expected.height);
      checks.push(makeCheck('video_dimensions', dimensionsPass ? 'PASS' : 'FAIL', dimensionsPass ? 'Video dimensions match expected metadata' : 'Video dimensions do not match expected metadata', { actualWidth: video.width, actualHeight: video.height, expectedWidth: expected.width, expectedHeight: expected.height }));
    }
    if (audio) {
      const audioShapePass = (!expected.audioSampleRate || Number(audio.sample_rate) === expected.audioSampleRate) && (!expected.audioChannels || Number(audio.channels) === expected.audioChannels);
      checks.push(makeCheck('audio_metadata', audioShapePass ? 'PASS' : 'FAIL', audioShapePass ? 'Audio sample rate/channels match expected metadata' : 'Audio metadata does not match expected values', { actualSampleRate: audio.sample_rate, actualChannels: audio.channels, expectedSampleRate: expected.audioSampleRate, expectedChannels: expected.audioChannels }));
    }

    const decodeRun = await runCommand(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', materialized.path, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'], { timeoutMs });
    checks.push(makeCheck('decode_integrity', decodeRun.code === 0 ? 'PASS' : 'FAIL', decodeRun.code === 0 ? 'Full media decode completed without FFmpeg errors' : 'FFmpeg detected decode/container corruption or truncation', { stderr: decodeRun.stderr.slice(-8000), exitCode: decodeRun.code, signal: decodeRun.signal || null }));
    return buildResult(checks, probe, checksum, expected, startedAt, materialized.sizeBytes);
  } catch (error) {
    const retryable = error.retryable === true || error.code === 'MEDIA_QA_TIMEOUT';
    checks.push(makeCheck('execution', 'FAIL', error.message, { code: error.code || 'MEDIA_QA_ERROR', retryable }));
    return buildResult(checks, probe, checksum, expected, startedAt, materialized?.sizeBytes || null);
  } finally {
    await materialized?.cleanup?.();
  }
}

function buildResult(checks, probe, expected, checksum, startedAt, sizeBytes) {
  return {
    schemaVersion: 'forge-media-qa-v1',
    status: resultStatus(checks),
    checks,
    probe: probe ? { format: probe.format || null, streams: (probe.streams || []).map((s) => ({ index: s.index, codecType: s.codec_type, codecName: s.codec_name, width: s.width, height: s.height, sampleRate: s.sample_rate, channels: s.channels, duration: s.duration })) } : null,
    checksum: checksum || null,
    expected,
    durationMs: Date.now() - startedAt,
    sizeBytes,
    deterministic: true,
  };
}

module.exports = { validateMediaArtifact, materializeMedia, sha256File, parseExpectedMetadata, resultStatus, MP4_FORMATS };
