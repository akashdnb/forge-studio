'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildVisualRecipe, applyRecipeToTimeline } = require('../src/visual/visual-continuity');
const { compileTimeline } = require('../src/pipeline/timeline-manifest-compiler');
const { renderTimeline } = require('../src/pipeline/ffmpeg-renderer');

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
}
function runFfmpeg(ffmpeg, args) { return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); }
function decodedFrameHash(ffmpeg, file) {
  const frame = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return crypto.createHash('sha256').update(frame).digest('hex');
}

test('continuity anchors select compatible real media and preserve its pixels through compilation/render', async (t) => {
  const ffmpeg = ffmpegPath();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-continuity-anchor-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const wrong = path.join(workDir, 'wrong.mp4');
  const right = path.join(workDir, 'right.mp4');
  runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', wrong]);
  runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', right]);

  const plan = { scenes: [{ id: 'scene-1', narrationText: 'Dr Rao explains the laboratory process', shots: [{ id: 'shot-1', shotType: 'DETAIL', durationSeconds: 1, visualSubject: 'Dr Rao', location: 'lab', continuityAnchors: { palette: 'cool' } }] }] };
  const assets = [
    { id: 'wrong', versionId: 'asset-wrong', role: 'DETAIL', description: 'Dr Rao laboratory process close-up', location: 'street', palette: 'warm', contentHash: 'wrong', sourcePath: 'wrong.mp4' },
    { id: 'right', versionId: 'asset-right', role: 'DETAIL', description: 'equipment close-up', location: 'lab', palette: 'cool', contentHash: 'right', sourcePath: 'right.mp4' },
  ];
  const recipe = buildVisualRecipe({ episodeId: 'ep-continuity', scenePlanVersionId: 'scene-plan-1', plan, assets });
  assert.equal(recipe.broll[0].selectedAssetId, 'right');
  assert.equal(recipe.broll[0].requirement.continuityAnchors.location, 'lab');

  const timeline = applyRecipeToTimeline({ durationSeconds: 1, tracks: [{ type: 'VIDEO', segments: [{ id: 'shot-1', start: 0, duration: 1, sourcePath: 'right.mp4', assetVersionId: 'asset-wrong' }] }] }, recipe, new Map(assets.map((asset) => [asset.id, { id: asset.id, versionId: asset.versionId }])));
  assert.equal(timeline.tracks[0].segments[0].assetVersionId, 'asset-right');
  const compiled = compileTimeline({ episodeId: 'ep-continuity', timeline, versions: { 'asset-right': { kind: 'asset' }, 'asset-wrong': { kind: 'asset' }, 'scene-plan-1': { kind: 'scene_plan' } } });
  assert.equal(compiled.tracks[0].segments[0].sourceVersionId, 'asset-right');

  const rendered = await renderTimeline({
    input: { timeline: { ...compiled, tracks: compiled.tracks }, timelineVersionId: 'timeline-continuity-1', timelineContentHash: compiled.checksum, inputVersionIds: compiled.inputVersionIds },
    workDir,
    outputPath: path.join(workDir, 'rendered.mp4'),
    ffmpegPath: ffmpeg,
  });
  assert.ok(rendered.sizeBytes > 0);
  const renderedHash = decodedFrameHash(ffmpeg, rendered.outputPath);
  assert.equal(renderedHash, decodedFrameHash(ffmpeg, right), 'final decoded pixels must come from the continuity-compatible selected asset');
  assert.notEqual(renderedHash, decodedFrameHash(ffmpeg, wrong), 'a conflicting continuity asset must not reach final pixels');
});
