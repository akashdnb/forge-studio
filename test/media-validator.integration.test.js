const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compileDeliveryProfile } = require('../src/publishing/delivery-profiles');
const { validateMp4 } = require('../src/packaging/media-validator');

function ffmpeg(args) {
  const result = spawnSync(process.env.FORGE_FFMPEG_COMMAND || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('validates a real downloadable MP4 for ffprobe metadata and full decode', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-validator-'));
  const output = path.join(dir, 'forge-video.mp4');
  try {
    const profile = compileDeliveryProfile('downloadable_mp4', { title: 'fixture' });
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.2', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', output,
    ]);
    const result = await validateMp4({ file: output, profile });
    assert.equal(result.video.codec, 'h264');
    assert.equal(result.video.width, 1920);
    assert.equal(result.video.height, 1080);
    assert.equal(result.video.fps, 30);
    assert.equal(result.audio.codec, 'aac');
    assert.equal(result.audio.sampleRate, 48000);
    assert.equal(result.audio.channels, 2);
    assert.ok(result.durationSeconds > 1.9 && result.durationSeconds < 2.1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejects a non-media artifact before it can be published', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-validator-invalid-'));
  const output = path.join(dir, 'forge-video.mp4');
  try {
    await fs.writeFile(output, Buffer.from('not an mp4'));
    const profile = compileDeliveryProfile('downloadable_mp4', { title: 'fixture' });
    await assert.rejects(() => validateMp4({ file: output, profile }), (error) => error.code === 'MEDIA_VALIDATION_FAILED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
