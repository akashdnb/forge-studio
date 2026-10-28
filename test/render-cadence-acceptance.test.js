'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

function command(commandName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${commandName} exited ${code}: ${stderr}`)));
  });
}

test('acceptance: 25fps moving source is encoded at 30fps without duplicate decoded cadence', async (t) => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    await command(ffmpeg, ['-version']);
    await command(ffprobe, ['-version']);
  } catch {
    t.skip('ffmpeg/ffprobe are not installed in this environment');
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cadence-qa-'));
  const source = path.join(dir, 'source.mp4');
  const output = path.join(dir, 'final.mp4');
  try {
    await command(ffmpeg, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'setsar=2/1',
      '-an', source,
    ]);

    const timeline = {
      tracks: [{ type: 'VIDEO', segments: [{ id: 'cadence-shot', start: 0, duration: 2, sourcePath: 'source.mp4' }] }],
      durationSeconds: 2,
    };
    await renderTimeline({
      input: { timeline, timelineVersionId: 'cadence-qa', timelineContentHash: sha256Json(timeline) },
      workDir: dir,
      outputPath: output,
    });

    const probe = JSON.parse((await command(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_aspect_ratio,display_aspect_ratio,nb_frames',
      '-of', 'json', output,
    ])).stdout).streams[0];

    assert.equal(Number(probe.width), 1280);
    assert.equal(Number(probe.height), 720);
    assert.equal(probe.pix_fmt, 'yuv420p');
    assert.equal(probe.r_frame_rate, '30/1');
    assert.equal(probe.avg_frame_rate, '30/1');
    assert.equal(probe.sample_aspect_ratio, '1:1');
    assert.equal(probe.display_aspect_ratio, '16:9');
    assert.equal(Number(probe.nb_frames), 60);

    const decoded = await command(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-i', output,
      '-vf', 'mpdecimate=hi=768:lo=320:frac=0.1,showinfo',
      '-an', '-f', 'null', '-',
    ]);
    const uniqueDecodedFrames = decoded.stderr.match(/ n:\s+[0-9]+ pts:/g)?.length || 0;
    assert.equal(uniqueDecodedFrames, 60, `duplicate/stutter cadence detected: only ${uniqueDecodedFrames}/60 decoded frames survived mpdecimate`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
