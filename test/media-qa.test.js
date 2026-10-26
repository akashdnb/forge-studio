const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const { validateMediaArtifact } = require('../src/media/media-qa-runtime');

let tempDir;
let goodPath;
let goodHash;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-qa-test-'));
  goodPath = path.join(tempDir, 'fixture.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', goodPath], { stdio: 'inherit' });
  goodHash = crypto.createHash('sha256').update(await fs.readFile(goodPath)).digest('hex');
});

after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

function artifact(filePath, overrides = {}) {
  return { id: 'render-1', kind: 'render', versionId: 'render-version-1', storageUri: new URL(`file://${filePath}`).toString(), contentHash: goodHash, mediaType: 'video/mp4', metadata: { expectedMedia: { durationSeconds: 2, durationToleranceSeconds: 0.2, videoCodec: 'h264', audioCodec: 'aac', width: 320, height: 180, audioSampleRate: 48000, audioChannels: 1 } }, ...overrides };
}

test('passes a real deterministic MP4 with expected provenance and streams', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.checksum.hash, goodHash);
  assert.equal(result.expected.durationSeconds, 2);
  assert.ok(result.checks.some((check) => check.name === 'decode_integrity' && check.status === 'PASS'));
});

test('fails checksum mismatch without claiming media success', async () => {
  const result = await validateMediaArtifact({ artifact: artifact(goodPath, { contentHash: '0'.repeat(64) }), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.checks.find((check) => check.name === 'checksum').status, 'FAIL');
});

test('detects truncation/corruption through ffmpeg decode', async () => {
  const truncated = path.join(tempDir, 'truncated.mp4');
  const source = await fs.readFile(goodPath);
  await fs.writeFile(truncated, source.subarray(0, Math.floor(source.length * 0.55)));
  const result = await validateMediaArtifact({ artifact: artifact(truncated, { contentHash: null }), timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.checks.some((check) => ['container', 'decode_integrity'].includes(check.name) && check.status === 'FAIL'));
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
