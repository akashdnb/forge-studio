const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderAudioPost, normalizeSegments } = require('../src/pipeline/audio-post-production');
const { buildCaptionBundle } = require('../src/captions/caption-worker');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

test('acceptance: final audio duration and caption cues share the same timeline clock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-audio-caption-sync-'));
  try {
    const ffmpeg = (args) => { const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    const ffprobe = (file) => { const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'video.mp4')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path.join(dir, 'narration.wav')]);

    const durationSeconds = 4;
    const segments = normalizeSegments([{ type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: 4, assetVersionId: 'narration:v1' }] }], durationSeconds);
    const audio = await renderAudioPost({
      inputFiles: [{ versionId: 'narration:v1', checksum: 'fixture-narration', path: path.join(dir, 'narration.wav') }],
      segments,
      durationSeconds,
      outputPath: path.join(dir, 'post.wav')
    });

    const transcript = {
      language: 'en',
      segments: [
        { id: 'n1', start: 0, end: 2, text: 'first phrase', confidence: 1 },
        { id: 'n2', start: 2, end: 4, text: 'second phrase', confidence: 1 }
      ]
    };
    const captions = buildCaptionBundle({
      transcript,
      transcriptArtifact: { id: 'transcript:fixture', version_id: 'transcript:v1', content_hash: 'fixture-transcript' },
      timelineArtifact: { id: 'timeline:fixture', content: { durationSeconds } }
    });

    assert.deepEqual(captions.metadata.cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 2000], [2000, 4000]]);
    const audioProbe = ffprobe(audio.outputPath);
    assert.equal(Number(audioProbe.streams[0].sample_rate), 48000);
    assert.equal(Number(audioProbe.streams[0].channels), 2);
    assert.ok(Math.abs(Number(audioProbe.format.duration) - durationSeconds) <= 0.08);
    assert.equal(captions.metadata.cues.at(-1).endMs, Math.round(Number(audioProbe.format.duration) * 1000));

    const baseManifest = {
      schemaVersion: 'forge-audio-caption-sync-v1',
      manifestKind: 'render-manifest',
      compilerVersion: 'acceptance',
      episodeId: 'acceptance-episode',
      timelineVersionId: 'timeline:fixture',
      timelineContentHash: sha256Json({ durationSeconds }),
      inputVersionIds: ['timeline:fixture', audio.recipeIdentity, 'transcript:v1'],
      durationSeconds,
      tracks: [
        { type: 'VIDEO', segments: [{ id: 'video', start: 0, duration: durationSeconds, sourcePath: 'video.mp4' }] },
        { type: 'NARRATION', segments: [{ id: 'narration', start: 0, duration: durationSeconds, sourcePath: 'post.wav' }] }
      ]
    };
    const manifest = { ...baseManifest, manifestChecksum: sha256Json(baseManifest) };
    const rendered = await renderTimeline({ input: { manifest, workDir: dir }, workDir: dir, outputPath: path.join(dir, 'acceptance.mp4') });
    assert.ok(rendered.sizeBytes > 0);
    const finalProbe = ffprobe(path.join(dir, 'acceptance.mp4'));
    const finalAudio = finalProbe.streams.find((stream) => stream.codec_name === 'aac');
    assert.equal(Number(finalAudio.sample_rate), 48000);
    assert.equal(Number(finalAudio.channels), 2);
    assert.ok(Math.abs(Number(finalProbe.format.duration) - durationSeconds) < 0.15);
    assert.ok(captions.metadata.cues.every((cue) => cue.endMs <= Math.round(Number(finalProbe.format.duration) * 1000) + 150));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
