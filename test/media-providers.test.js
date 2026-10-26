const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { FfmpegRenderer, createMediaArtifact } = require('../src/providers/ffmpeg-renderer');
const { PiperTtsProvider, isPathInside } = require('../src/providers/piper-tts-provider');

test('media adapters reject paths outside their configured output roots', async () => {
  const root = path.join(os.tmpdir(), 'forge-media-test');
  const renderer = new FfmpegRenderer({ outputRoot: root });
  await assert.rejects(renderer.render({ inputPath: '/tmp/outside.mp4', outputPath: path.join(root, 'output.mp4') }), /inside the configured output root/);
  await assert.rejects(renderer.probe('/tmp/outside.mp4'), /inside the configured output root/);
  assert.equal(isPathInside(root, path.join(root, 'x.wav')), true);
  assert.equal(isPathInside(root, '/tmp/forge-media-test-evil/x.wav'), false);
});

test('media artifacts expose metadata and version provenance, not media bytes', () => {
  const artifact = createMediaArtifact({
    episodeId: 'ep-1',
    versionId: 'render-v1',
    output: { path: '/tmp/forge-media/output.mp4', durationSeconds: 12, sizeBytes: 2048, formatName: 'mp4', streams: [{ codecType: 'video', codecName: 'h264' }] },
    inputVersionIds: ['scene-v1', 'narration-v2'],
  });
  assert.equal(artifact.kind, 'render');
  assert.equal(artifact.mediaType, 'video/mp4');
  assert.deepEqual(artifact.inputVersionIds, ['scene-v1', 'narration-v2']);
  assert.equal(artifact.metadata.durationSeconds, 12);
  assert.equal('bytes' in artifact, false);
});

test('Piper adapter requires explicit model and output root and blocks traversal', async () => {
  assert.throws(() => new PiperTtsProvider({ outputRoot: '/tmp/forge-media' }), /PIPER_MODEL_PATH is required/);
  const provider = new PiperTtsProvider({ modelPath: '/models/en_US-test.onnx', outputRoot: '/tmp/forge-media' });
  assert.equal(provider.name, 'piper');
  await assert.rejects(provider.execute({ text: 'Hello', outputPath: '/tmp/outside.wav' }, { runId: 'run-1', inputVersionIds: [] }), /inside outputRoot/);
});
