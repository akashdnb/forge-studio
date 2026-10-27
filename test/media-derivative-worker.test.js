const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { derivativeIdentity, derivativeArtifactId, normalizeRecipe } = require('../src/media/derivative-recipes');
const { validateMediaMetadata, ffmpegArgs } = require('../src/media/derivative-worker');

const exec = promisify(execFile);

 test('derivative identity is deterministic and content-addressed by recipe/version', () => {
  const sourceChecksum = 'a'.repeat(64);
  const a = derivativeIdentity({ sourceChecksum, recipe: { type: 'poster', timestampSeconds: 2 } });
  const b = derivativeIdentity({ sourceChecksum, recipe: { timestampSeconds: 2, type: 'poster' } });
  const c = derivativeIdentity({ sourceChecksum, recipe: { type: 'poster', timestampSeconds: 3 } });
  assert.equal(a.identity, b.identity);
  assert.notEqual(a.identity, c.identity);
  assert.equal(derivativeArtifactId({ sourceChecksum, recipe: { type: 'poster', timestampSeconds: 2 } }), `derivative:${a.identity}`);
});

test('recipe validation rejects unbounded preview and contact-sheet requests', () => {
  assert.throws(() => normalizeRecipe({ type: 'clip', durationSeconds: 31 }), /Preview clip/);
  assert.throws(() => normalizeRecipe({ type: 'contact-sheet', count: 13 }), /Contact sheet/);
  assert.throws(() => normalizeRecipe({ type: 'proxy', maxDurationSeconds: 901 }), /Proxy duration/);
});

test('probe validation rejects corrupt, oversized and hostile metadata', () => {
  assert.throws(() => validateMediaMetadata({ streams: [], format: { duration: 1 } }), /duration/);
  assert.throws(() => validateMediaMetadata({ streams: [{ codec_type: 'video', codec_name: 'proprietary', width: 1, height: 1 }], format: { duration: 1, format_name: 'mp4' } }), /codec/);
  assert.throws(() => validateMediaMetadata({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 100, height: 100 }], format: { duration: 3601, format_name: 'mp4' } }), /duration/);
});

test('real ffmpeg fixture can produce a deterministic poster derivative', async (t) => {
  try { await exec('ffmpeg', ['-version']); } catch { t.skip('ffmpeg unavailable in this environment'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-derivative-test-'));
  const input = path.join(dir, 'fixture.mp4');
  const output = path.join(dir, 'poster.jpg');
  try {
    await exec('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=10','-t','1','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',input]);
    const probe = await exec('ffprobe', ['-v','error','-show_entries','format=duration,size:stream=codec_type,codec_name,width,height','-of','json',input]);
    const metadata = JSON.parse(probe.stdout);
    const validated = validateMediaMetadata(metadata);
    assert.ok(validated.durationSeconds > 0);
    const args = ffmpegArgs(normalizeRecipe({ type: 'poster', timestampSeconds: 0.2 }), input, output, validated.durationSeconds);
    await exec('ffmpeg', args);
    const stat = await fs.stat(output);
    assert.ok(stat.size > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
