'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES, compileDeliveryProfile, ffmpegArgs, fingerprint, sanitize } = require('../src/publishing/delivery-profiles');
const { runFfmpeg, sha256File } = require('../src/packaging/delivery-worker');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('delivery profiles are deterministic and platform-specific', () => {
  assert.deepEqual(Object.keys(PROFILES), ['youtube_long_form', 'youtube_shorts', 'downloadable_mp4']);
  const longForm = compileDeliveryProfile('youtube_long_form', { title: 'A / B: C', tags: ['history', 'history', '  maps  '] });
  const again = compileDeliveryProfile('youtube_long_form', { title: 'A / B: C', tags: ['history', 'history', '  maps  '] });
  const shorts = compileDeliveryProfile('youtube_shorts', { title: 'Short' });
  assert.equal(longForm.fingerprint, again.fingerprint); assert.equal(longForm.video.width, 1920); assert.equal(shorts.video.width, 1080); assert.equal(shorts.video.height, 1920); assert.equal(longForm.metadata.tags.length, 2); assert.equal(longForm.filename, 'A B C.mp4');
});

test('profile compiler clamps metadata and keeps publish-safe defaults', () => {
  const profile = compileDeliveryProfile('youtube_long_form', { title: '  Safe title  ', description: 'x'.repeat(6000), privacyStatus: 'invalid', containsSyntheticMedia: true });
  assert.equal(profile.metadata.title, 'Safe title'); assert.equal(profile.metadata.description.length, 5000); assert.equal(profile.metadata.privacyStatus, 'private'); assert.equal(profile.metadata.containsSyntheticMedia, true); assert.equal(sanitize('a<>:"/\\|?*'), 'a');
});

test('ffmpeg arguments encode exact resolution, fps, bitrate, codecs and faststart', () => {
  const profile = compileDeliveryProfile('youtube_shorts', { title: 'short' }); const args = ffmpegArgs(profile);
  assert.ok(args.includes('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30')); assert.ok(args.includes('libx264')); assert.ok(args.includes('8000k')); assert.ok(args.includes('aac')); assert.ok(args.includes('+faststart')); assert.equal(fingerprint(profile), profile.fingerprint);
});

test('delivery worker checksum helper is content-addressed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delivery-test-')); const file = path.join(dir, 'x.mp4');
  try { await fs.writeFile(file, Buffer.from('delivery')); assert.equal(await sha256File(file), 'b4af39d5b65a14849e885a9d65f0efe4f4e689989689c28c16cfcb3a6e78db5a'); } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('delivery worker reports ffmpeg failure instead of simulating success', async () => {
  await assert.rejects(() => runFfmpeg(['-e', 'process.exit(1)'], { timeoutMs: 1000, signal: null }), /ffmpeg failed|Unable to start ffmpeg/);
});
