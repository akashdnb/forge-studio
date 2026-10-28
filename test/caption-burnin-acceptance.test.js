const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function ffmpegCommand() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function hasFfmpeg() {
  try {
    execFileSync(ffmpegCommand(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'buffer',
    ...options,
  });
}

function frameHasBrightCaption(outputPath, timestamp) {
  const frame = run(ffmpegCommand(), [
    '-ss', String(timestamp),
    '-i', outputPath,
    '-frames:v', '1',
    '-vf', 'crop=iw:ih/3:0:2*ih/3,format=gray',
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    '-',
  ]);
  let brightPixels = 0;
  for (const value of frame) if (value > 45) brightPixels += 1;
  return brightPixels;
}

test('acceptance: caption burn-in is visible on the final MP4 at the timeline cue times', { skip: !hasFfmpeg() }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-caption-burnin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const videoPath = path.join(root, 'video.mp4');
  const narrationPath = path.join(root, 'narration.wav');
  const outputPath = path.join(root, 'final.mp4');

  run(ffmpegCommand(), [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ]);
  run(ffmpegCommand(), [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', narrationPath,
  ]);

  const timeline = {
    durationSeconds: 4,
    inputVersionIds: ['video:v1', 'narration:v1'],
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'video', start: 0, duration: 4, sourcePath: 'video.mp4' }] },
      { type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: 4, sourcePath: 'narration.wav' }] },
      { type: 'CAPTIONS', segments: [
        { id: 'caption-1', start: 0, duration: 2, text: 'first caption' },
        { id: 'caption-2', start: 2, duration: 2, text: 'second caption' },
      ] },
    ],
  };

  const rendered = await renderTimeline({
    input: {
      timeline,
      timelineVersionId: 'timeline:v1',
      timelineContentHash: sha256Json(timeline),
    },
    workDir: root,
    outputPath,
    timeoutMs: 120000,
  });

  assert.ok(rendered.sizeBytes > 0);
  assert.equal(rendered.metadata.captionCueCount, 2);

  const beforeCue = frameHasBrightCaption(outputPath, 0.5);
  const firstCue = frameHasBrightCaption(outputPath, 1.0);
  const secondCue = frameHasBrightCaption(outputPath, 2.5);

  assert.ok(firstCue > beforeCue + 20, `first caption is not visibly burned in: before=${beforeCue}, at-1s=${firstCue}`);
  assert.ok(secondCue > beforeCue + 20, `second caption is not visibly burned in: before=${beforeCue}, at-2.5s=${secondCue}`);
});
