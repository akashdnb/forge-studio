const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json, buildFfmpegArgs, validateRenderInput } = require('../src/pipeline/ffmpeg-renderer');

function binary(name) {
  const configured = name === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (configured) return configured;
  try {
    return require(name === 'ffmpeg' ? 'ffmpeg-static' : '@ffprobe-installer/ffprobe').path;
  } catch {
    return name;
  }
}

function hasFfmpeg() {
  try {
    execFileSync(binary('ffmpeg'), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('render input hash is deterministic and rejects mutation', () => {
  const timeline = { durationSeconds: 1, tracks: [{ type: 'VIDEO', segments: [{ id: 'scene-1', start: 0, duration: 1, sourcePath: 'fixtures/scene.mp4' }] }] };
  const hash = sha256Json(timeline);
  assert.equal(hash, sha256Json(JSON.parse(JSON.stringify(timeline))));
  assert.throws(() => validateRenderInput({ timeline: { ...timeline, durationSeconds: 2 }, timelineVersionId: 'timeline:v1', timelineContentHash: hash, workDir: process.cwd() }), /hash mismatch/);
});

test('ffmpeg command is bounded and propagates camera motion intent', () => {
  const timeline = { durationSeconds: 2, tracks: [{ type: 'VIDEO', segments: [{ id: 'scene-1', start: 0, duration: 2, sourcePath: 'fixtures/scene.mp4', shotSpec: { cameraMotion: 'PUSH_IN' } }] }] };
  const args = buildFfmpegArgs({ timeline, workDir: '/tmp', durationSeconds: 2 }, '/tmp/out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /zoompan=z='1\+0\.08\*min\(1,on\/\(30\*2\)\)'/);
  assert.ok(args.includes('-t'));
  assert.ok(args.includes('2'));
  assert.ok(args.includes('-map_metadata'));
  assert.ok(args.includes('-1'));
  assert.ok(args.includes('libx264'));
});

test('renderer produces a real MP4 with checksum and metadata', { skip: !hasFfmpeg() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-render-'));
  const fixtureDir = path.join(root, 'fixtures');
  await fs.mkdir(fixtureDir);
  const source = path.join(fixtureDir, 'scene.mp4');
  execFileSync(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
  const timeline = { durationSeconds: 1, tracks: [{ type: 'VIDEO', segments: [{ id: 'scene-1', start: 0, duration: 1, sourcePath: 'fixtures/scene.mp4' }] }] };
  const result = await renderTimeline({ input: { timeline, timelineVersionId: 'timeline:v1', timelineContentHash: sha256Json(timeline), inputVersionIds: ['timeline:v1'] }, workDir: root, outputPath: path.join(root, 'out.mp4'), timeoutMs: 60000 });
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.ok(result.sizeBytes > 0);
  assert.equal(result.metadata.mediaType, 'video/mp4');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'out.mp4.json'), 'utf8')).sha256, result.checksum);
});

test('camera motion changes pixels without changing media contract', { skip: !hasFfmpeg() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-camera-motion-'));
  const fixtureDir = path.join(root, 'fixtures');
  await fs.mkdir(fixtureDir);
  const source = path.join(fixtureDir, 'testsrc2.mp4');
  execFileSync(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);

  const render = async (cameraMotion, filename) => {
    const timeline = {
      durationSeconds: 2,
      tracks: [{ type: 'VIDEO', segments: [{ id: 'scene-1', start: 0, duration: 2, sourcePath: 'fixtures/testsrc2.mp4', shotSpec: { cameraMotion } }] }],
    };
    return renderTimeline({
      input: { timeline, timelineVersionId: `timeline:${cameraMotion}`, timelineContentHash: sha256Json(timeline), inputVersionIds: [`timeline:${cameraMotion}`] },
      workDir: root,
      outputPath: path.join(root, filename),
      timeoutMs: 60000,
    });
  };

  const staticResult = await render('STATIC', 'static.mp4');
  const pushResult = await render('PUSH_IN', 'push.mp4');
  assert.notEqual(staticResult.checksum, pushResult.checksum, 'camera motion must change rendered pixels');

  const probe = JSON.parse(execFileSync(binary('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', path.join(root, 'push.mp4')], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams[0], { width: 1280, height: 720, r_frame_rate: '30/1' });

  const durationProbe = JSON.parse(execFileSync(binary('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(root, 'push.mp4')], { encoding: 'utf8' }));
  assert.ok(Math.abs(Number(durationProbe.format.duration) - 2) < 0.05, `duration drifted: ${durationProbe.format.duration}`);
});
