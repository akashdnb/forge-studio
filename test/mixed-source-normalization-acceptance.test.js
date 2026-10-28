const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function ffmpegCommand() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function ffprobeCommand() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function hasBinary(command) {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'buffer',
    ...options,
  });
}

function createSource(root, name, { size, fps, color, pixFmt, sar = '1/1' }) {
  const output = path.join(root, name);
  run(ffmpegCommand(), [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=1`,
    '-vf', `setsar=${sar},drawbox=x=0:y=0:w=iw-1:h=ih-1:t=8:c=white`,
    '-c:v', 'libx264', '-pix_fmt', pixFmt, '-frames:v', String(Math.ceil(Number(fps))), output,
  ]);
  return output;
}

function probeVideo(file) {
  return JSON.parse(run(ffprobeCommand(), [
    '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,sample_aspect_ratio,pix_fmt,r_frame_rate,avg_frame_rate,color_range,color_space,color_transfer,color_primaries',
    '-of', 'json', file,
  ], { encoding: 'utf8' })).streams[0];
}

function decodeFrame(file, timestamp) {
  return run(ffmpegCommand(), [
    '-ss', String(timestamp), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
}

function regionMean(frame, width, height, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const i = (y * width + x) * 3;
    r += frame[i]; g += frame[i + 1]; b += frame[i + 2]; count += 1;
  }
  return [r / count, g / count, b / count];
}

function assertDominant(mean, channel, label) {
  const other = mean.filter((_, i) => i !== channel).reduce((a, b) => a + b, 0) / 2;
  assert.ok(mean[channel] > other + 70, `${label}: expected channel ${channel} to dominate, mean=${mean.map(Math.round)}`);
}

function assertMostlyBlack(mean, label) {
  assert.ok(mean.every((value) => value < 12), `${label}: expected black padding, mean=${mean.map(Math.round)}`);
}

test('acceptance: mixed VIDEO sources normalize resolution, SAR, pixel format and source rate without boundary corruption', {
  skip: !(hasBinary(ffmpegCommand()) && hasBinary(ffprobeCommand())),
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mixed-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const sources = [
    createSource(root, 'red-640x360-420.mp4', { size: '640x360', fps: '24', color: 'red', pixFmt: 'yuv420p' }),
    createSource(root, 'green-1920x1080-444.mp4', { size: '1920x1080', fps: '25', color: 'green', pixFmt: 'yuv444p' }),
    createSource(root, 'blue-720x576-sar2x-422.mp4', { size: '720x576', fps: '25', color: 'blue', pixFmt: 'yuv422p', sar: '2/1' }),
    createSource(root, 'yellow-1080-square-420.mp4', { size: '1080x1080', fps: '30000/1001', color: 'yellow', pixFmt: 'yuv420p' }),
  ];

  const sourceProbes = sources.map(probeVideo);
  assert.deepEqual(sourceProbes.map((s) => [s.width, s.height, s.pix_fmt, s.sample_aspect_ratio]), [
    [640, 360, 'yuv420p', '1:1'],
    [1920, 1080, 'yuv444p', '1:1'],
    [720, 576, 'yuv422p', '2:1'],
    [1080, 1080, 'yuv420p', '1:1'],
  ]);

  const timeline = {
    durationSeconds: 4,
    inputVersionIds: ['mixed:v1'],
    tracks: [{
      type: 'VIDEO',
      segments: sources.map((sourcePath, index) => ({
        id: `shot-${index + 1}`,
        start: index,
        duration: 1,
        sourcePath: path.basename(sourcePath),
      })),
    }],
  };

  const outputPath = path.join(root, 'final.mp4');
  const rendered = await renderTimeline({
    input: {
      timeline,
      timelineVersionId: 'mixed:v1',
      timelineContentHash: sha256Json(timeline),
    },
    workDir: root,
    outputPath,
    timeoutMs: 120000,
  });

  assert.ok(rendered.sizeBytes > 0);
  const outputProbe = probeVideo(outputPath);
  assert.equal(outputProbe.width, 1280);
  assert.equal(outputProbe.height, 720);
  assert.equal(outputProbe.sample_aspect_ratio, '1:1');
  assert.equal(outputProbe.pix_fmt, 'yuv420p');
  assert.equal(outputProbe.r_frame_rate, '30/1');
  assert.equal(outputProbe.avg_frame_rate, '30/1');

  const expectedChannels = [0, 1, 2, 0];
  for (let index = 0; index < 4; index += 1) {
    const frame = decodeFrame(outputPath, index + 0.5);
    const center = regionMean(frame, 1280, 720, 320, 180, 960, 540);
    assertDominant(center, expectedChannels[index], `shot ${index + 1} center`);
  }

  const blueFrame = decodeFrame(outputPath, 2.5);
  assertMostlyBlack(regionMean(blueFrame, 1280, 720, 0, 0, 1280, 80), 'shot 3 top edge');
  assertMostlyBlack(regionMean(blueFrame, 1280, 720, 0, 640, 1280, 720), 'shot 3 bottom edge');

  const yellowFrame = decodeFrame(outputPath, 3.5);
  assertMostlyBlack(regionMean(yellowFrame, 1280, 720, 0, 0, 160, 720), 'shot 4 left edge');
  assertMostlyBlack(regionMean(yellowFrame, 1280, 720, 1120, 0, 1280, 720), 'shot 4 right edge');

  const beforeGreen = regionMean(decodeFrame(outputPath, 0.96), 1280, 720, 320, 180, 960, 540);
  const atGreen = regionMean(decodeFrame(outputPath, 1.04), 1280, 720, 320, 180, 960, 540);
  assertDominant(beforeGreen, 0, 'pre-boundary shot 1');
  assertDominant(atGreen, 1, 'post-boundary shot 2');
});
