const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function ffmpeg() { return process.env.FFMPEG_PATH || 'ffmpeg'; }
function ffprobe() { return process.env.FFPROBE_PATH || 'ffprobe'; }
function hasMediaTools() {
  try {
    execFileSync(ffmpeg(), ['-version'], { stdio: 'ignore' });
    execFileSync(ffprobe(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function probe(file, args) {
  return JSON.parse(execFileSync(ffprobe(), ['-v', 'error', '-print_format', 'json', ...args, file], { encoding: 'utf8' }));
}

test('renderer honors deliberately different shot durations and preserves audio/timeline contracts', { skip: !hasMediaTools() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shot-duration-'));
  const fixtureDir = path.join(root, 'fixtures');
  await fs.mkdir(fixtureDir);
  const first = path.join(fixtureDir, 'first.mp4');
  const second = path.join(fixtureDir, 'second.mp4');

  execFileSync(ffmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', first,
  ]);
  execFileSync(ffmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', second,
  ]);

  const timeline = {
    durationSeconds: 4,
    tracks: [
      { type: 'VIDEO', segments: [
        { id: 'shot-1', start: 0, duration: 1.25, sourcePath: 'fixtures/first.mp4' },
        { id: 'shot-2', start: 1.25, duration: 2.75, sourcePath: 'fixtures/second.mp4' },
      ] },
      { type: 'NARRATION', segments: [
        { id: 'audio-1', start: 0, duration: 1.25, sourcePath: 'fixtures/first.mp4' },
        { id: 'audio-2', start: 1.25, duration: 2.75, sourcePath: 'fixtures/second.mp4' },
      ] },
    ],
  };
  const outputPath = path.join(root, 'rendered.mp4');
  const result = await renderTimeline({
    input: {
      timeline,
      timelineVersionId: 'timeline:shot-duration-acceptance',
      timelineContentHash: sha256Json(timeline),
      inputVersionIds: ['timeline:shot-duration-acceptance'],
    },
    workDir: root,
    outputPath,
    timeoutMs: 60000,
  });

  const streams = probe(outputPath, ['-show_streams', '-show_format']);
  const video = streams.streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(video.r_frame_rate, '30/1');
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(streams.format.duration) - 4) < 0.05, `timeline duration drifted: ${streams.format.duration}`);

  const frames = probe(outputPath, ['-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time']);
  const timestamps = frames.frames.map((frame) => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
  assert.equal(timestamps.length, 120, `expected 120 frames for 4s @ 30fps, got ${timestamps.length}`);
  assert.equal(timestamps.filter((timestamp) => timestamp < 1.25).length, 38);
  assert.equal(timestamps.filter((timestamp) => timestamp >= 1.25).length, 82);
  assert.ok(Math.abs(timestamps[38] - 1.266667) < 0.01, `second shot did not begin at the planned 1.25s boundary: ${timestamps[38]}`);
  assert.ok(Math.abs(Number(result.metadata.durationSeconds) - 4) < 0.001);
});
