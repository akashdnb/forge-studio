const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeSegments, renderAudioPost } = require('../src/pipeline/audio-post-production');
const { renderTimeline } = require('../src/pipeline/ffmpeg-renderer');
const { compileTimeline } = require('../src/pipeline/timeline-manifest-compiler');
const { transcribeWithWhisper } = require('../src/transcription/whisper-worker');
const { buildCaptionBundle } = require('../src/captions/caption-worker');

function run(command, args, cwd) {
  const result = spawnSync(command, ['-hide_banner', '-loglevel', 'error', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
  return result;
}

test('acceptance: narration, Whisper timestamps, captions, compiled timeline and final MP4 share one clock', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-audio-caption-clock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const videoPath = path.join(dir, 'video.mp4');
  const narrationPath = path.join(dir, 'narration.wav');
  const postPath = path.join(dir, 'post.wav');
  const whisperFixture = path.join(dir, 'whisper-fixture.js');
  const outputPath = path.join(dir, 'final.mp4');

  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], dir);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', narrationPath], dir);

  await fs.writeFile(whisperFixture, `process.stdout.write(JSON.stringify({language:'en',segments:[{start:0,end:2,text:'first caption',confidence:0.91},{start:2,end:4,text:'second caption',confidence:0.89}]}));\n`);
  const previousCommand = process.env.FORGE_WHISPER_COMMAND;
  const previousArgs = process.env.FORGE_WHISPER_ARGS;
  process.env.FORGE_WHISPER_COMMAND = process.execPath;
  process.env.FORGE_WHISPER_ARGS = whisperFixture;
  t.after(() => {
    if (previousCommand === undefined) delete process.env.FORGE_WHISPER_COMMAND;
    else process.env.FORGE_WHISPER_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.FORGE_WHISPER_ARGS;
    else process.env.FORGE_WHISPER_ARGS = previousArgs;
  });

  const transcript = await transcribeWithWhisper(narrationPath, { timeoutMs: 5000 });
  assert.deepEqual(transcript.segments.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0, end: 2, text: 'first caption' },
    { start: 2, end: 4, text: 'second caption' },
  ]);
  assert.equal(transcript.durationSeconds, 4);

  const transcriptArtifact = { id: 'transcript-acceptance', version_id: 'transcript:v1', content_hash: 'a'.repeat(64) };
  const captionBundle = buildCaptionBundle({ transcript, transcriptArtifact });
  assert.deepEqual(captionBundle.cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 2000], [2000, 4000]]);
  assert.equal(captionBundle.metadata.cueCount, 2);

  const audioSegments = normalizeSegments([{ type: 'NARRATION', segments: [{ start: 0, duration: 4, assetVersionId: 'narration:v1' }] }], 4);
  const audio = await renderAudioPost({
    inputFiles: [{ versionId: 'narration:v1', checksum: 'local-narration-fixture', path: narrationPath }],
    segments: audioSegments,
    durationSeconds: 4,
    outputPath: postPath,
  });
  assert.ok(Math.abs(audio.durationSeconds - 4) < 0.08);

  const timeline = {
    durationSeconds: 4,
    inputVersionIds: ['video:v1', 'narration:v1', 'transcript:v1'],
    tracks: [
      { type: 'VIDEO', segments: [{ id: 'video', start: 0, duration: 4, assetVersionId: 'video:v1', sourcePath: 'video.mp4' }] },
      { type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: 4, assetVersionId: 'narration:v1', sourcePath: 'post.wav' }] },
      { type: 'CAPTIONS', segments: [
        { id: 'caption-1', start: 0, duration: 2, sourceVersionId: 'transcript:v1', text: 'first caption' },
        { id: 'caption-2', start: 2, duration: 2, sourceVersionId: 'transcript:v1', text: 'second caption' },
      ] },
    ],
  };
  const manifest = compileTimeline({
    episodeId: 'episode-audio-caption-acceptance',
    timeline,
    versions: {
      'video:v1': { kind: 'asset' },
      'narration:v1': { kind: 'narration' },
      'transcript:v1': { kind: 'asset' },
    },
  });

  assert.equal(manifest.durationSeconds, 4);
  const captionTrack = manifest.tracks.find((track) => track.type === 'CAPTIONS');
  assert.deepEqual(captionTrack.segments.map(({ start, end }) => [start, end]), [[0, 2], [2, 4]]);
  assert.equal(manifest.tracks.find((track) => track.type === 'NARRATION').segments[0].end, 4);

  const rendered = await renderTimeline({ input: { manifest, workDir: dir }, workDir: dir, outputPath });
  assert.ok(rendered.sizeBytes > 0);

  const probe = run('ffprobe', [
    '-show_entries', 'stream=index,codec_type,codec_name,sample_rate,channels,duration:format=duration',
    '-of', 'json', outputPath,
  ], dir);
  const metadata = JSON.parse(probe.stdout);
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audioStream.codec_name, 'aac');
  assert.equal(Number(audioStream.sample_rate), 48000);
  assert.equal(Number(audioStream.channels), 2);

  const finalDuration = Number(metadata.format.duration);
  assert.ok(Math.abs(finalDuration - manifest.durationSeconds) < 0.15, `final duration ${finalDuration}s drifted from timeline ${manifest.durationSeconds}s`);
  assert.ok(Number(audioStream.duration) > 0);
  assert.ok(Math.abs(Number(audioStream.duration) - manifest.durationSeconds) < 0.15);
  assert.ok(captionBundle.cues.every((cue) => cue.startMs / 1000 >= 0 && cue.endMs / 1000 <= finalDuration + 0.15));
});
