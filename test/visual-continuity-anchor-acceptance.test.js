'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnFileSync } = require('node:child_process');
const { test } = require('node:test');
const { buildVisualRecipe, applyRecipeToTimeline, sha256 } = require('../src/visual/visual-continuity');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function toolPath(moduleName, fallback) {
  try {
    return require(moduleName);
  } catch {
    return fallback;
  }
}

const ffmpegPath = toolPath('ffmpeg-static', 'ffmpeg');
const ffprobePath = toolPath('@ffprobe-installer/ffprobe', 'ffprobe')?.path || toolPath('@ffprobe-installer/ffprobe', 'ffprobe');

function runTool(command, args, options = {}) {
  return spawnFileSync(command, args, { stdio: 'pipe', ...options });
}

function assertToolAvailable(command, args = ['-version']) {
  const result = runTool(command, args);
  if (result.error || result.status !== 0) {
    return false;
  }
  return true;
}

function createSource(output, color) {
  const result = runTool(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:r=30`, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', output]);
  assert.equal(result.status, 0, result.stderr?.toString() || 'ffmpeg fixture generation failed');
}

test('continuity anchors deterministically prefer the matching visual asset', () => {
  const plan = {
    scenes: [{
      id: 'scene-1',
      location: 'lab',
      style: 'documentary',
      lighting: 'NATURAL',
      visualSubject: 'hero',
      shots: [{
        id: 'shot-1',
        shotType: 'B_ROLL',
        durationSeconds: 1,
        continuityAnchors: { palette: 'cool' },
      }],
    }],
  };
  const assets = [
    { id: 'a-mismatch', versionId: 'v-red', role: 'ESTABLISHING', description: 'laboratory environment', location: 'lab', style: 'documentary', lighting: 'NATURAL', palette: 'warm', subject: 'hero', durationSeconds: 1 },
    { id: 'z-match', versionId: 'v-blue', role: 'ESTABLISHING', description: 'laboratory environment', location: 'lab', style: 'documentary', lighting: 'NATURAL', palette: 'cool', subject: 'hero', durationSeconds: 1 },
  ];
  const recipe = buildVisualRecipe({ episodeId: 'ep-1', scenePlanVersionId: 'scene-v1', plan, assets });
  const selection = recipe.broll.find((entry) => entry.shotId === 'shot-1');
  assert.equal(selection.selectedAssetId, 'z-match');
  assert.ok(selection.suitabilityScore > 0.9);
  assert.equal(selection.ranked[0].assetId, 'z-match');
});

test('continuity selection reaches final pixels in the production renderer', async (t) => {
  if (!assertToolAvailable(ffmpegPath) || !assertToolAvailable(ffprobePath)) {
    t.skip('ffmpeg/ffprobe unavailable in the acceptance environment');
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-visual-continuity-'));
  t.after(async () => fs.rm(workDir, { recursive: true, force: true }));

  const red = path.join(workDir, 'red.mp4');
  const blue = path.join(workDir, 'blue.mp4');
  const output = path.join(workDir, 'final.mp4');
  createSource(red, 'red');
  createSource(blue, 'blue');

  const plan = {
    scenes: [{
      id: 'scene-1',
      location: 'lab',
      style: 'documentary',
      lighting: 'NATURAL',
      visualSubject: 'hero',
      shots: [{ id: 'shot-1', shotType: 'B_ROLL', durationSeconds: 1, continuityAnchors: { palette: 'cool' } }],
    }],
  };
  const assets = [
    { id: 'a-mismatch', versionId: 'v-red', role: 'ESTABLISHING', description: 'laboratory environment', location: 'lab', style: 'documentary', lighting: 'NATURAL', palette: 'warm', subject: 'hero', durationSeconds: 1, contentHash: sha256('red') },
    { id: 'z-match', versionId: 'v-blue', role: 'ESTABLISHING', description: 'laboratory environment', location: 'lab', style: 'documentary', lighting: 'NATURAL', palette: 'cool', subject: 'hero', durationSeconds: 1, contentHash: sha256('blue') },
  ];
  const recipe = buildVisualRecipe({ episodeId: 'ep-1', scenePlanVersionId: 'scene-v1', plan, assets });
  const assetById = new Map([
    ['a-mismatch', { ...assets[0], sourcePath: 'red.mp4' }],
    ['z-match', { ...assets[1], sourcePath: 'blue.mp4' }],
  ]);
  const timeline = applyRecipeToTimeline({
    durationSeconds: 1,
    tracks: [{ type: 'VIDEO', segments: [{ id: 'shot-1', shotId: 'shot-1', start: 0, duration: 1, sourcePath: 'placeholder.mp4', assetVersionId: 'v-red' }] }],
  }, recipe, assetById);
  const selected = recipe.broll[0].selectedAssetId;
  timeline.tracks[0].segments[0].sourcePath = assetById.get(selected).sourcePath;
  timeline.inputVersionIds = ['v-blue'];

  const result = await renderTimeline({
    input: {
      timeline,
      timelineVersionId: 'timeline-v1',
      timelineContentHash: sha256Json(timeline),
    },
    workDir,
    outputPath: output,
    ffmpegPath,
  });
  assert.equal(result.metadata.mediaType, 'video/mp4');

  const probe = runTool(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,pix_fmt', '-of', 'json', output]);
  assert.equal(probe.status, 0, probe.stderr?.toString() || 'ffprobe failed');
  const stream = JSON.parse(probe.stdout.toString()).streams[0];
  assert.deepEqual(stream, { width: 1280, height: 720, r_frame_rate: '30/1', pix_fmt: 'yuv420p' });

  const pixel = runTool(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'crop=1:1:640:360,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(pixel.status, 0, pixel.stderr?.toString() || 'pixel decode failed');
  const [r, g, b] = pixel.stdout;
  assert.ok(b > 200 && r < 20 && g < 20, `expected the continuity-matched blue asset in final pixels, got rgb(${r},${g},${b})`);
});
