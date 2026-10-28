const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { framingFilter, getFramingZoom } = require('../src/pipeline/shot-render-profile');
const { buildFfmpegArgs, renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function ffmpegPath() { return process.env.FFMPEG_PATH || 'ffmpeg'; }
function ffprobePath() { return process.env.FFPROBE_PATH || 'ffprobe'; }
function hasMediaTools() {
  try { execFileSync(ffmpegPath(), ['-version'], { stdio: 'ignore' }); execFileSync(ffprobePath(), ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('shot framing profiles are deterministic and bounded', () => {
  assert.equal(getFramingZoom({ framing: 'WIDE' }), 1);
  assert.equal(getFramingZoom({ framing: 'CLOSE' }), 1.38);
  assert.equal(getFramingZoom({ framing: 'EXTREME_CLOSE' }), 1.7);
  assert.match(framingFilter({ framing: 'WIDE' }, 0, 'wide', 2, 1280, 720), /scale=1280:720/);
  assert.match(framingFilter({ framing: 'CLOSE' }, 0, 'close', 2, 1280, 720), /crop=1280:720/);
});

test('renderer maps shotSpec framing to the video filter without changing timeline timing', () => {
  const timeline = {
    durationSeconds: 2,
    tracks: [{ type: 'VIDEO', segments: [
      { id: 'wide', start: 0, duration: 1, sourcePath: 'fixtures/scene.mp4', shotSpec: { framing: 'WIDE' } },
      { id: 'close', start: 1, duration: 1, sourcePath: 'fixtures/scene.mp4', shotSpec: { framing: 'CLOSE' } },
    ] }],
  };
  const args = buildFfmpegArgs({ timeline, workDir: '/tmp', durationSeconds: 2 }, '/tmp/out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:v\].*scale=1280:720/);
  assert.match(filter, /\[1:v\].*crop=1280:720/);
  assert.match(filter, /concat=n=2:v=1:0\[vout\]/);
});

test('representative render preserves MP4 dimensions and duration while changing framing output', { skip: !hasMediaTools() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shot-framing-'));
  const fixtureDir = path.join(root, 'fixtures');
  await fs.mkdir(fixtureDir);
  const source = path.join(fixtureDir, 'scene.mp4');
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
  const render = async (framing, name) => renderTimeline({
    input: {
      timeline: { durationSeconds: 1, tracks: [{ type: 'VIDEO', segments: [{ id: name, start: 0, duration: 1, sourcePath: 'fixtures/scene.mp4', shotSpec: { framing } }] }] },
      timelineVersionId: `timeline:${name}`,
      timelineContentHash: sha256Json({ durationSeconds: 1, tracks: [{ type: 'VIDEO', segments: [{ id: name, start: 0, duration: 1, sourcePath: 'fixtures/scene.mp4', shotSpec: { framing } }] }] }),
      inputVersionIds: [`timeline:${name}`],
    }, workDir: root, outputPath: path.join(root, `${name}.mp4`), timeoutMs: 60000,
  });
  const wide = await render('WIDE', 'wide');
  const close = await render('CLOSE', 'close');
  assert.notEqual(wide.checksum, close.checksum, 'framing intent must change rendered bytes for a non-uniform source');
  for (const file of [wide.outputPath, close.outputPath]) {
    const probe = JSON.parse(execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' }));
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(video.r_frame_rate, '30/1');
    assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.05);
  }
});
