const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function binary(name) {
  const configured = name === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (configured) return configured;
  try {
    return require(name === 'ffmpeg' ? 'ffmpeg-static' : '@ffprobe-installer/ffprobe').path;
  } catch {
    return name;
  }
}

function hasMediaTools() {
  try {
    execFileSync(binary('ffmpeg'), ['-version'], { stdio: 'ignore' });
    execFileSync(binary('ffprobe'), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('transition intent changes final pixels while preserving video and audio contracts', { skip: !hasMediaTools() }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-transition-render-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture.mp4');

  execFileSync(binary('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', fixture,
  ]);

  const render = async (transitionIntent, filename) => {
    const timeline = {
      durationSeconds: 2,
      tracks: [{
        type: 'VIDEO',
        segments: [{
          id: 'shot-1',
          start: 0,
          duration: 2,
          sourcePath: 'fixture.mp4',
          shotSpec: { transitionIntent },
        }],
      }, {
        type: 'NARRATION',
        segments: [{ id: 'audio-1', start: 0, duration: 2, sourcePath: 'fixture.mp4' }],
      }],
    };
    return renderTimeline({
      input: {
        timeline,
        timelineVersionId: `timeline:${transitionIntent}`,
        timelineContentHash: sha256Json(timeline),
        inputVersionIds: [`timeline:${transitionIntent}`],
      },
      workDir: root,
      outputPath: path.join(root, filename),
      timeoutMs: 60000,
    });
  };

  const neutral = await render('CUT', 'neutral.mp4');
  const intended = await render('FADE', 'fade.mp4');
  assert.notEqual(neutral.checksum, intended.checksum, 'transition intent must change rendered pixels');

  for (const filename of ['neutral.mp4', 'fade.mp4']) {
    const probe = JSON.parse(execFileSync(binary('ffprobe'), [
      '-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
      '-show_entries', 'format=duration', '-of', 'json', path.join(root, filename),
    ], { encoding: 'utf8' }));
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    assert.deepEqual({ width: video.width, height: video.height, r_frame_rate: video.r_frame_rate }, { width: 1280, height: 720, r_frame_rate: '30/1' });
    assert.equal(video.codec_name, 'h264');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.sample_rate, '48000');
    assert.equal(audio.channels, 2);
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.05, `duration drifted: ${probe.format.duration}`);
  }
});
