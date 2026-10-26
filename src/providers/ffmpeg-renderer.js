const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function normalizeTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1000 || value > 3600000) throw new TypeError('timeoutMs must be between 1000 and 3600000');
  return value;
}

/**
 * Execute a binary without a shell; URLs/arguments are never interpolated into a shell command.
 * The returned content is metadata about the generated file, not the media bytes.
 */
class FfmpegRenderer {
  constructor({ ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', outputRoot, timeoutMs = 600000 }) {
    if (!outputRoot) throw new TypeError('outputRoot is required');
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.outputRoot = path.resolve(outputRoot);
    this.timeoutMs = normalizeTimeout(timeoutMs, 600000);
  }

  async render({ inputPath, outputPath, args = [], overwrite = false }) {
    const input = path.resolve(inputPath);
    const output = path.resolve(outputPath);
    if (!input.startsWith(this.outputRoot + path.sep) || !output.startsWith(this.outputRoot + path.sep)) {
      throw new Error('Renderer paths must be inside the configured output root');
    }
    const allArgs = [overwrite ? '-y' : '-n', '-i', input, ...args, output];
    await this.#run(this.ffmpegPath, allArgs);
    const metadata = await this.probe(output);
    return { path: output, ...metadata };
  }

  async probe(filePath) {
    const file = path.resolve(filePath);
    if (!file.startsWith(this.outputRoot + path.sep)) throw new Error('Probe path must be inside the configured output root');
    const result = await this.#run(this.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('ffprobe returned invalid JSON'); }
    const duration = Number(parsed.format?.duration);
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      formatName: parsed.format?.format_name || null,
      sizeBytes: Number.isFinite(Number(parsed.format?.size)) ? Number(parsed.format.size) : null,
      streams: (parsed.streams || []).map((stream) => ({
        codecType: stream.codec_type || null, codecName: stream.codec_name || null,
        width: stream.width || null, height: stream.height || null,
        sampleRate: stream.sample_rate || null, channels: stream.channels || null,
        durationSeconds: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null,
      })),
    };
  }

  async #run(binary, args) {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const maxLogBytes = 256 * 1024;
    child.stdout.on('data', (chunk) => { if (stdout.length < maxLogBytes) stdout += chunk.toString('utf8').slice(0, maxLogBytes - stdout.length); });
    child.stderr.on('data', (chunk) => { if (stderr.length < maxLogBytes) stderr += chunk.toString('utf8').slice(0, maxLogBytes - stderr.length); });
    const timeoutMs = this.timeoutMs;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    const [code, signal] = await once(child, 'close').then(([code, signal]) => [code, signal]).finally(() => clearTimeout(timer));
    if (code !== 0) {
      const error = new Error(`${path.basename(binary)} failed (code=${code}, signal=${signal || 'none'}): ${stderr.slice(-4000)}`);
      error.code = 'MEDIA_PROCESS_FAILED';
      throw error;
    }
    return { stdout, stderr };
  }
}

function createMediaArtifact({ id = randomUUID(), episodeId, versionId, kind = 'render', output, inputVersionIds = [], renderer = 'ffmpeg' }) {
  if (!output || !output.path) throw new TypeError('output.path is required');
  return {
    id, episodeId, versionId, kind,
    storageUri: output.path,
    mediaType: output.streams?.some((s) => s.codecType === 'video') ? 'video/mp4' : 'application/octet-stream',
    source: renderer,
    inputVersionIds: [...new Set(inputVersionIds)],
    metadata: { durationSeconds: output.durationSeconds, sizeBytes: output.sizeBytes, formatName: output.formatName, streams: output.streams },
  };
}

module.exports = { FfmpegRenderer, createMediaArtifact };
