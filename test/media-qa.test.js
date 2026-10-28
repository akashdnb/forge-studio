const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const { validateMediaArtifact } = require('../src/media/media-qa-runtime');

let tempDir, goodPath, badAudioPath, goodHash;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-qa-test-'));
  goodPath = path.join(tempDir, 'fixture.mp4');
  badAudioPath = path.join(tempDir, 'short-audio-fixture.mp4');

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', goodPath,
  ], { stdio: 'inherit' });

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-t', '2', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-t', '2', '-i', 'sine=frequency=660:sample_rate=48000',
    '-filter_complex', '[1:a][2:a]amerge=inputs=2[a]',
    '-map', '0:v:0', '-map', '[a]',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart', badAudioPath,
  ], { stdio: 'inherit' });

  goodHash = crypto.createHash('sha256').update(await fs.readFile(goodPath)).digest('hex');
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function artifact(filePath, overrides = {}) {
  return {
    id: 'render-1',
    kind: 'render',
    versionId: 'render-version-1',
    storageUri: new URL(`file://${filePath}`).toString(),
    contentHash: goodHash,
    mediaType: 'video/mp4',
    metadata: {
      expectedMedia: {
        durationSeconds: 2,
        durationToleranceSeconds: 0.2,
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: 320,
        height: 180,
        audioSampleRate: 48000,
        audioChannels: 1,
      },
    },
    ...overrides,
  };
}

function probe(filePath) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-bitexact', filePath,
  ], { encoding: 'utf8' }));
}

test('passes a real deterministic MP4 with expected provenance and streams', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.checksum.hash, goodHash);
  assert.equal(result.expected.durationSeconds, 2);
  assert.equal(result.checks.find((c) => c.name === 'audio_duration').status, 'PASS');
  assert.ok(result.checks.some((c) => c.name === 'decode_integrity' && c.status === 'PASS'));
});

test('rejects deterministic media whose encoded AAC stream ends before the video timeline', async () => {
  const metadata = probe(badAudioPath);
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(video && audio);
  assert.ok(Math.abs(Number(metadata.format.duration) - 4) <= 0.1);
  assert.ok(Math.abs(Number(video.duration) - 4) <= 0.1);
  assert.equal(Number(video.nb_frames), 120);
  assert.equal(video.r_frame_rate, '30/1');
  assert.ok(Math.abs(Number(audio.duration) - 2) <= 0.01);
  assert.equal(Number(audio.nb_frames), 95);
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(Number(audio.channels), 2);

  const pcmBytes = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', badAudioPath,
    '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ]);
  const pcmSamplesPerChannel = pcmBytes.length / 2 / Number(audio.channels);
  assert.ok(pcmSamplesPerChannel >= 96000 && pcmSamplesPerChannel <= 96500);

  const result = await validateMediaArtifact({
    artifact: artifact(badAudioPath, { contentHash: null }),
    timeoutMs: 30000,
    maxBytes: 20 * 1024 * 1024,
    payload: { timelineMetadata: { durationSeconds: 4, durationToleranceSeconds: 0.2, audioChannels: 2 } },
  });
  const audioCheck = result.checks.find((c) => c.name === 'audio_duration');
  assert.equal(result.status, 'FAILED');
  assert.equal(audioCheck.status, 'FAIL');
  assert.ok(Number(audioCheck.details.actualSeconds) < 2.2);
});

test('fails checksum mismatch without claiming media success', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath, { contentHash: '0'.repeat(64) }), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.checks.find((c) => c.name === 'checksum').status, 'FAIL');
});

test('detects truncation/corruption through ffmpeg decode', async () => {
  const truncated = path.join(tempDir, 'truncated.mp4');
  const source = await fs.readFile(goodPath);
  await fs.writeFile(truncated, source.subarray(0, Math.floor(source.length * 0.55)));
  const result = await validateMediaArtifact({ artifact: artifact(truncated, { contentHash: null }), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.checks.some((c) => ['container', 'decode_integrity'].includes(c.name) && c.status === 'FAIL'));
});

test('rejects unallowlisted HTTP media locations before fetching', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath, { storageUri: 'https://example.invalid/video.mp4' }), timeoutMs: 5000, maxBytes: 20 * 1024 * 1024, allowedHosts: [] });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.checks.at(-1).details.code, 'MEDIA_QA_HOST_NOT_ALLOWED');
});

test('enforces a bounded media size before ffmpeg execution', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath), timeoutMs: 30000, maxBytes: 128 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.checks.at(-1).details.code, 'MEDIA_QA_SIZE_LIMIT');
});
