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

function ffprobeCommand() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function hasBinary(command) {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
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

function probe(outputPath) {
  return JSON.parse(run(ffprobeCommand(), [
    '-show_streams',
    '-show_format',
    '-of', 'json',
    outputPath,
  ]).toString('utf8'));
}

function assertNear(actual, expected, tolerance, label) {
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

test('acceptance: final MP4 has deterministic player-compatible container, video, color and clock metadata', { skip: !hasBinary(ffmpegCommand()) || !hasBinary(ffprobeCommand()) }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mp4-compat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const videoPath = path.join(root, 'video.mp4');
  const narrationPath = path.join(root, 'narration.wav');
  const outputPath = path.join(root, 'final.mp4');

  run(ffmpegCommand(), [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ]);
  run(ffmpegCommand(), [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', narrationPath,
  ]);

  const timeline = {
    durationSeconds: 3,
    inputVersionIds: ['video:v1', 'narration:v1'],
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'video', start: 0, duration: 3, sourcePath: 'video.mp4' }] },
      { type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: 3, sourcePath: 'narration.wav' }] },
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
  const media = await fs.readFile(outputPath);
  const moov = media.indexOf(Buffer.from('moov'));
  const mdat = media.indexOf(Buffer.from('mdat'));
  assert.ok(moov >= 0, 'MP4 must contain moov atom');
  assert.ok(mdat >= 0, 'MP4 must contain mdat atom');
  assert.ok(moov < mdat, `moov must precede mdat for progressive playback: moov=${moov}, mdat=${mdat}`);

  const metadata = probe(outputPath);
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(video, 'final MP4 must contain a video stream');
  assert.ok(audio, 'final MP4 must contain an audio stream');

  assert.equal(video.codec_name, 'h264');
  assert.equal(video.profile, 'High');
  assert.ok(Number(video.level) <= 31, `720p30 H.264 should remain within level 3.1: ${video.level}`);
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(video.color_range, 'tv');
  assert.equal(video.color_space, 'bt709');
  assert.equal(video.color_transfer, 'bt709');
  assert.equal(video.color_primaries, 'bt709');
  assert.equal(video.time_base, '1/15360');
  assert.equal(video.start_time, '0.000000');
  assertNear(video.duration, 3, 0.001, 'video duration');

  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channel_layout, 'stereo');
  assert.equal(audio.time_base, '1/48000');
  assert.equal(audio.start_time, '0.000000');
  assertNear(audio.duration, 3, 0.001, 'audio duration');

  assert.equal(metadata.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.equal(metadata.format.start_time, '0.000000');
  assertNear(metadata.format.duration, 3, 0.001, 'container duration');

  // Playback-oriented validation: decode the complete shipped MP4 and one seeked frame.
  run(ffmpegCommand(), ['-i', outputPath, '-f', 'null', '-']);
  run(ffmpegCommand(), ['-ss', '1.5', '-i', outputPath, '-frames:v', '1', '-f', 'null', '-']);
});
