const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { validateMediaArtifact } = require('../src/media/media-qa-runtime');

let tempDir;
let cleanPath;
let videoGapPath;
let audioGapPath;

const expectedMedia = {
  durationSeconds: 2,
  durationToleranceSeconds: 0.2,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 320,
  height: 180,
  audioSampleRate: 48000,
  audioChannels: 1,
};

function runFfmpeg(args) {
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function artifact(filePath) {
  return {
    id: 'render-timestamp-fixture',
    kind: 'render',
    versionId: 'render-timestamp-fixture-v1',
    storageUri: new URL(`file://${filePath}`).toString(),
    contentHash: null,
    mediaType: 'video/mp4',
    metadata: { expectedMedia },
  };
}

function probeFrames(filePath, stream) {
  return execFileSync(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-select_streams', `${stream}:0`, '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,duration_time,nb_samples',
    '-of', 'json', filePath,
  ], { encoding: 'utf8' });
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-final-media-timestamp-'));
  cleanPath = path.join(tempDir, 'clean-multishot.mp4');
  videoGapPath = path.join(tempDir, 'video-gap.mp4');
  audioGapPath = path.join(tempDir, 'audio-gap.mp4');

  const commonVideo = ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1'];
  runFfmpeg([...commonVideo, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-t', '2', cleanPath]);
  runFfmpeg([...commonVideo, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS+gte(N\\,25)*0.5/TB[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-t', '2', videoGapPath]);
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:d=2', '-filter_complex', '[1:a]aselect=not(between(t\\,1\\,1.5)),asetpts=PTS[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-t', '2', audioGapPath]);
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('accepts a deterministic multi-shot MP4 when decoded frame/sample timing is continuous', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(cleanPath), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.checks.find((check) => check.name === 'timestamp_integrity').status, 'PASS');
  assert.equal(result.checks.find((check) => check.name === 'decode_integrity').status, 'PASS');
});

test('rejects a video PTS gap at a shot join even though duration and full decode succeed', async () => {
  const frameProbe = JSON.parse(probeFrames(videoGapPath, 'v')).frames;
  const timestamps = frameProbe.map((frame) => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
  const joinGap = timestamps[25] - timestamps[24];
  assert.ok(joinGap > 0.4, `expected a deterministic video join gap, got ${joinGap}s`);
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', videoGapPath, '-f', 'null', '-']);

  const result = await validateMediaArtifact({ artifact: artifact(videoGapPath), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  const timestampCheck = result.checks.find((check) => check.name === 'timestamp_integrity');
  assert.equal(timestampCheck.status, 'FAIL');
  assert.match(timestampCheck.details.errors.join('\n'), /video decoded frame PTS.*gap|video packet PTS.*gap/);
  assert.equal(result.checks.find((check) => check.name === 'duration').status, 'PASS');
  assert.equal(result.checks.find((check) => check.name === 'decode_integrity').status, 'PASS');
});

test('rejects an audio clock gap represented by a decoded frame/sample duration mismatch', async () => {
  const frameProbe = JSON.parse(probeFrames(audioGapPath, 'a')).frames;
  const discontinuousFrame = frameProbe.find((frame) => Number(frame.duration_time) > 0.1);
  assert.ok(discontinuousFrame, 'expected a deterministic audio discontinuity frame');
  assert.equal(Number(discontinuousFrame.nb_samples), 1024);
  assert.ok(Number(discontinuousFrame.duration_time) > 0.5);
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', audioGapPath, '-f', 'null', '-']);

  const result = await validateMediaArtifact({ artifact: artifact(audioGapPath), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  const timestampCheck = result.checks.find((check) => check.name === 'timestamp_integrity');
  assert.equal(timestampCheck.status, 'FAIL');
  assert.match(timestampCheck.details.errors.join('\n'), /audio decoded frame .*duration .* does not match .* samples/);
  assert.equal(result.checks.find((check) => check.name === 'decode_integrity').status, 'PASS');
});
