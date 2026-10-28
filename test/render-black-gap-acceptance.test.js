const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { renderTimeline, sha256Json, VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS } = require('../src/pipeline/ffmpeg-renderer');

function run(args, { encoding } = {}) {
  const result = spawnSync(ffmpegPath, args, { encoding, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || 'ffmpeg fixture command failed');
  return result;
}

function frameLuma(file, timestamp) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', file,
    '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'
  ]);
  assert.equal(result.status, 0, result.stderr?.toString() || 'frame extraction failed');
  assert.equal(result.stdout.length, 1);
  return result.stdout[0];
}

function legacyGappedFixture(root) {
  const file = path.join(root, 'legacy-gapped.mp4');
  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', '1', '-i', 'color=c=red:s=320x180:r=30',
    '-f', 'lavfi', '-t', '0.5', '-i', 'color=c=black:s=320x180:r=30',
    '-f', 'lavfi', '-t', '1', '-i', 'color=c=blue:s=320x180:r=30',
    '-filter_complex', '[0:v]setsar=1[v0];[1:v]setsar=1[v1];[2:v]setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[vout]',
    '-map', '[vout]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-f', 'mp4', file
  ]);
  return file;
}

test('deterministic multi-shot fixture proves current renderer could emit a black shot-boundary gap and renderer now rejects it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-black-gap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const legacy = legacyGappedFixture(root);
  const before = frameLuma(legacy, 0.5);
  const gap = frameLuma(legacy, 1.25);
  const after = frameLuma(legacy, 1.75);
  assert.ok(before > 40, `expected first shot to contain non-black pixels, got luma ${before}`);
  assert.ok(gap < 8, `expected deterministic black gap, got luma ${gap}`);
  assert.ok(after > 20, `expected second shot to contain non-black pixels, got luma ${after}`);

  const blackDetect = run([
    '-hide_banner', '-loglevel', 'info', '-i', legacy,
    '-vf', 'blackdetect=d=0.4:pix_th=0.1:pic_th=0.98', '-an', '-f', 'null', '-'
  ], { encoding: 'utf8' });
  assert.match(blackDetect.stderr, /black_start:/, 'fixture must contain an FFmpeg-detected black interval');
  assert.match(blackDetect.stderr, /black_duration:0\.4|black_duration:0\.5|black_duration:0\.466667/, 'fixture must report a material black interval');

  const red = path.join(root, 'red.mp4');
  const blue = path.join(root, 'blue.mp4');
  run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-t', '1', '-i', 'color=c=red:s=320x180:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-t', '1', '-i', 'color=c=blue:s=320x180:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);

  const timeline = {
    tracks: [{ type: 'VIDEO', segments: [
      { id: 'shot-1', start: 0, duration: 1, sourcePath: 'red.mp4' },
      { id: 'shot-2', start: 1.5, duration: 1, sourcePath: 'blue.mp4' }
    ] }],
    durationSeconds: 2.5
  };
  const input = {
    timeline,
    timelineVersionId: 'timeline-black-gap-fixture',
    timelineContentHash: sha256Json(timeline),
    inputVersionIds: [],
    workDir: root
  };

  await assert.rejects(
    () => renderTimeline({ input, workDir: root, outputPath: path.join(root, 'rejected.mp4'), ffmpegPath }),
    (error) => error.code === 'VIDEO_TIMELINE_GAP' && error.gapSeconds === 0.5
  );

  const continuous = {
    tracks: [{ type: 'VIDEO', segments: [
      { id: 'shot-1', start: 0, duration: 1, sourcePath: 'red.mp4' },
      { id: 'shot-2', start: 1, duration: 1, sourcePath: 'blue.mp4' }
    ] }],
    durationSeconds: 2
  };
  const output = path.join(root, 'continuous.mp4');
  const rendered = await renderTimeline({
    input: { timeline: continuous, timelineVersionId: 'timeline-continuous-fixture', timelineContentHash: sha256Json(continuous), inputVersionIds: [], workDir: root },
    workDir: root,
    outputPath: output,
    ffmpegPath
  });
  assert.equal(rendered.metadata.durationSeconds, 2);
  const probe = run(['-hide_banner', '-loglevel', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '-i', output], { encoding: 'utf8' });
  assert.ok(Math.abs(Number(probe.stdout.trim()) - 2) < 0.15);
  assert.equal(frameLuma(output, 0.5) > 40, true);
  assert.equal(frameLuma(output, 1.5) > 20, true);
  assert.equal(VIDEO_WIDTH, 1280);
  assert.equal(VIDEO_HEIGHT, 720);
  assert.equal(VIDEO_FPS, 30);
});
