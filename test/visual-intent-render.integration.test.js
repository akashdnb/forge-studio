const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileTimeline } = require('../src/pipeline/timeline-manifest-compiler');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(command, args, cwd) { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function frameHashes(file, cwd, frame) {
  const out = run(FFMPEG, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'framemd5', '-'], cwd);
  return out.split(/\r?\n/u).filter((line) => line && !line.startsWith('#')).at(-1)?.split(',').at(-1)?.trim();
}
function probe(file, cwd) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], cwd));
}

async function makeFixture(workDir) {
  run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', 'fixture.mp4'], workDir);
}

async function renderVariant(workDir, name, shotSpec) {
  const recipe = { version: 1, recipeId: `acceptance-${name}`, seed: 17, visualStyle: 'cinematic', continuityAnchors: ['subject-center'] };
  const timeline = compileTimeline({
    episodeId: `episode-${name}`,
    timeline: {
      durationSeconds: 2,
      visualRecipe: recipe,
      tracks: [
        { type: 'VIDEO', segments: [{ id: 'shot-1', start: 0, duration: 2, assetVersionId: 'asset-v1', sourcePath: 'fixture.mp4', shotSpec }] },
        { type: 'NARRATION', segments: [{ id: 'audio-1', start: 0, duration: 2, sourceVersionId: 'asset-v1', sourcePath: 'fixture.mp4' }] },
      ],
    },
    versions: { 'asset-v1': { kind: 'asset' } },
  });
  assert.deepEqual(timeline.tracks[0].segments[0].shotSpec, shotSpec);
  assert.deepEqual(timeline.visualRecipe, recipe);
  const outputPath = path.join(workDir, `${name}.mp4`);
  const result = await renderTimeline({ input: { timeline, timelineVersionId: `timeline-${name}`, timelineContentHash: sha256Json(timeline), inputVersionIds: ['asset-v1'] }, workDir, outputPath });
  return { ...result, probe: probe(outputPath, workDir) };
}

test('visual intent changes decoded pixels while preserving the media contract', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-visual-intent-'));
  try {
    await makeFixture(workDir);
    const cutStatic = await renderVariant(workDir, 'static-cut', { framing: 'MEDIUM', cameraMotion: 'STATIC', transitionIntent: 'CUT' });
    const closePush = await renderVariant(workDir, 'close-push', { framing: 'CLOSE', cameraMotion: 'PUSH_IN', transitionIntent: 'CUT' });
    const closeFade = await renderVariant(workDir, 'close-fade', { framing: 'CLOSE', cameraMotion: 'PUSH_IN', transitionIntent: 'FADE_IN' });

    assert.notEqual(cutStatic.checksum, closePush.checksum, 'framing/camera intent must change encoded output');
    assert.notEqual(closePush.checksum, closeFade.checksum, 'transition intent must change encoded output');
    assert.notEqual(frameHashes(cutStatic.outputPath, workDir, 45), frameHashes(closePush.outputPath, workDir, 45), 'framing/camera motion must survive into decoded pixels');
    assert.notEqual(frameHashes(closePush.outputPath, workDir, 0), frameHashes(closeFade.outputPath, workDir, 0), 'transition intent must survive into decoded pixels');

    for (const result of [cutStatic, closePush, closeFade]) {
      const video = result.probe.streams.find((stream) => stream.codec_type === 'video');
      const audio = result.probe.streams.find((stream) => stream.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264');
      assert.equal(Number(video.width), 1280);
      assert.equal(Number(video.height), 720);
      assert.equal(video.r_frame_rate, '30/1');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(Number(audio.sample_rate), 48000);
      assert.equal(Number(audio.channels), 2);
      assert.ok(Number(result.sizeBytes) > 0);
      assert.match(result.checksum, /^[0-9a-f]{64}$/u);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
