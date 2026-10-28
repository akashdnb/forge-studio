'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { compileTimeline } = require('../src/pipeline/timeline-manifest-compiler');
const { buildFfmpegArgs, renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function toolPath(moduleName, fallback) {
  try { return require(moduleName); } catch { return fallback; }
}

const ffmpegPath = toolPath('ffmpeg-static', 'ffmpeg');

function runTool(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'pipe', ...options });
}

function assertToolAvailable(command) {
  const result = runTool(command, ['-version']);
  return !result.error && result.status === 0;
}

function createSource(output) {
  const result = runTool(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=gray:s=1280x720:r=30', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', output,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString() || 'fixture generation failed');
}

function buildCompiledTimeline(sourcePath, palette) {
  const timeline = {
    durationSeconds: 1,
    inputVersionIds: ['asset-v1'],
    tracks: [{
      type: 'VIDEO',
      segments: [{
        id: 'shot-1',
        start: 0,
        duration: 1,
        sourcePath,
        assetVersionId: 'asset-v1',
        shotSpec: {
          shotType: 'B_ROLL',
          framing: 'MEDIUM',
          cameraMotion: 'STATIC',
          continuityAnchors: {
            subject: 'hero',
            location: 'lab',
            style: 'documentary',
            lighting: 'NATURAL',
            palette,
          },
        },
      }],
    }],
  };
  return compileTimeline({
    episodeId: 'ep-anchor',
    timeline,
    versions: { 'asset-v1': { kind: 'asset' } },
  });
}

function decodedFrameHash(output, workDir) {
  const result = runTool(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', output,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { cwd: workDir });
  assert.equal(result.status, 0, result.stderr?.toString() || 'frame decode failed');
  return crypto.createHash('sha256').update(result.stdout).digest('hex');
}

test('timeline compilation preserves immutable continuity anchors exactly', () => {
  const compiled = buildCompiledTimeline('gray.mp4', 'cool');
  assert.deepEqual(compiled.tracks[0].segments[0].shotSpec.continuityAnchors, {
    subject: 'hero',
    location: 'lab',
    style: 'documentary',
    lighting: 'NATURAL',
    palette: 'cool',
  });
});

test('continuity palette anchor changes the decoded final frame after compilation', async (t) => {
  if (!assertToolAvailable(ffmpegPath)) {
    t.skip('ffmpeg unavailable in the acceptance environment');
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-continuity-anchor-render-'));
  t.after(async () => fs.rm(workDir, { recursive: true, force: true }));

  const source = path.join(workDir, 'gray.mp4');
  const coolOutput = path.join(workDir, 'cool.mp4');
  const warmOutput = path.join(workDir, 'warm.mp4');
  createSource(source);

  const cool = buildCompiledTimeline('gray.mp4', 'cool');
  const warm = buildCompiledTimeline('gray.mp4', 'warm');
  assert.equal(cool.tracks[0].segments[0].shotSpec.continuityAnchors.palette, 'cool');
  assert.equal(warm.tracks[0].segments[0].shotSpec.continuityAnchors.palette, 'warm');

  const coolInput = { timeline: cool, timelineVersionId: 'timeline-cool', timelineContentHash: sha256Json(cool) };
  const warmInput = { timeline: warm, timelineVersionId: 'timeline-warm', timelineContentHash: sha256Json(warm) };
  const coolArgs = buildFfmpegArgs({ ...coolInput, workDir, durationSeconds: 1 }, coolOutput);
  const warmArgs = buildFfmpegArgs({ ...warmInput, workDir, durationSeconds: 1 }, warmOutput);
  assert.ok(coolArgs.includes('colorbalance=rs=-0.08:gs=0:bs=0.08'));
  assert.ok(warmArgs.includes('colorbalance=rs=0.08:gs=0:bs=-0.08'));
  assert.notEqual(coolArgs.join('\0'), warmArgs.join('\0'));

  await renderTimeline({ input: coolInput, workDir, outputPath: coolOutput, ffmpegPath });
  await renderTimeline({ input: warmInput, workDir, outputPath: warmOutput, ffmpegPath });

  const coolFrame = decodedFrameHash(coolOutput, workDir);
  const warmFrame = decodedFrameHash(warmOutput, workDir);
  assert.notEqual(coolFrame, warmFrame, 'different continuity palettes must produce different decoded frame hashes');
});
