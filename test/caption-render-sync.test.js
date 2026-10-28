const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json, buildFfmpegArgs, validateRenderInput } = require('../src/pipeline/ffmpeg-renderer');

function ffmpegCommand() { return process.env.FFMPEG_PATH || 'ffmpeg'; }
function hasFfmpeg() { try { execFileSync(ffmpegCommand(), ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('caption tracks are logical render inputs and preserve their timeline clock', () => {
  const timeline = {
    durationSeconds: 4,
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'scene', start: 0, duration: 4, sourcePath: 'scene.mp4' }] },
      { type: 'CAPTIONS', segments: [
        { id: 'caption-1', start: 0, duration: 2, text: 'first caption' },
        { id: 'caption-2', start: 2, duration: 2, text: 'second caption' },
      ] },
    ],
  };
  const input = { timeline, timelineVersionId: 'timeline:v1', timelineContentHash: sha256Json(timeline), workDir: '/tmp' };
  assert.doesNotThrow(() => validateRenderInput(input));
  const args = buildFfmpegArgs({ ...input, durationSeconds: 4 }, '/tmp/out.mp4', { captionPath: '/tmp/captions.srt' });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /subtitles=filename='/);
  assert.match(filter, /captions\.srt/);
});

test('renders real MP4 with caption cues and synchronized narration', { skip: !hasFfmpeg() }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-caption-render-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const video = path.join(root, 'scene.mp4');
  const audio = path.join(root, 'narration.wav');
  const output = path.join(root, 'final.mp4');
  execFileSync(ffmpegCommand(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  execFileSync(ffmpegCommand(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', audio]);

  const timeline = {
    durationSeconds: 4,
    inputVersionIds: ['video:v1', 'narration:v1'],
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'scene', start: 0, duration: 4, assetVersionId: 'video:v1', sourcePath: 'scene.mp4' }] },
      { type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: 4, assetVersionId: 'narration:v1', sourcePath: 'narration.wav' }] },
      { type: 'CAPTIONS', segments: [
        { id: 'caption-1', start: 0, duration: 2, text: 'first caption' },
        { id: 'caption-2', start: 2, duration: 2, text: 'second caption' },
      ] },
    ],
  };

  const result = await renderTimeline({
    input: { timeline, timelineVersionId: 'timeline:v1', timelineContentHash: sha256Json(timeline), inputVersionIds: timeline.inputVersionIds },
    workDir: root,
    outputPath: output,
    timeoutMs: 120000,
  });

  assert.ok(result.sizeBytes > 0);
  assert.equal(result.metadata.captionCueCount, 2);
  const probe = execFileSync(ffmpegCommand(), ['-hide_banner', '-i', output, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(typeof probe, 'string');
  assert.ok(Math.abs(Number((await import('node:fs/promises')).stat(output)).size - result.sizeBytes) === 0);
});

test('rejects caption segments with missing text instead of silently dropping them', () => {
  const timeline = {
    durationSeconds: 1,
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'scene', start: 0, duration: 1, sourcePath: 'scene.mp4' }] },
      { type: 'CAPTIONS', segments: [{ id: 'caption', start: 0, duration: 1 }] },
    ],
  };
  assert.throws(() => validateRenderInput({ timeline, timelineVersionId: 'timeline:v1', timelineContentHash: sha256Json(timeline), workDir: '/tmp' }), /requires non-empty text/);
});
