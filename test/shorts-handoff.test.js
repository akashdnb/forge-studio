const test = require('node:test');
const assert = require('node:assert/strict');
const { createShortsHandoff } = require('../src');

function episode(state = 'APPROVED') {
  return { id: 'ep-1', projectId: 'p-1', title: 'Why volcanoes erupt', state, approvedRenderId: 'render-1' };
}
function render() {
  return { id: 'render-1', episodeId: 'ep-1', versionId: 'render-v3', storageUri: 's3://bucket/final.mp4', contentHash: 'abc123' };
}

test('handoff preserves source lineage and allowed artifacts for purffle-shorts', () => {
  const payload = createShortsHandoff({
    episode: episode(), renderArtifact: render(),
    scriptArtifact: { id: 'script-1', versionId: 'script-v4', contentHash: 'script-hash', content: { text: 'Volcanoes erupt when...' } },
    captionsArtifact: { id: 'captions-1', versionId: 'captions-v2', storageUri: 's3://bucket/captions.vtt' },
    candidateSegments: [{ id: 'clip-1', startSeconds: 12, endSeconds: 42, title: 'The pressure builds', score: 0.9, sourceSceneVersionIds: ['scene-1'] }],
  });
  assert.equal(payload.schemaVersion, '1.0');
  assert.equal(payload.source.approvedRenderId, 'render-1');
  assert.equal(payload.source.renderVersionId, 'render-v3');
  assert.equal(payload.artifacts.script.versionId, 'script-v4');
  assert.equal(payload.candidateSegments[0].endSeconds, 42);
  assert.equal(payload.contract.consumerRepository, 'akashdnb/purffle-shorts');
  assert.equal(payload.contract.noPublicationPermissionGranted, true);
});

test('handoff cannot be created before approval or from a stale render', () => {
  assert.throws(() => createShortsHandoff({ episode: episode('QA'), renderArtifact: render() }), /Only an approved\/published episode/);
  assert.throws(() => createShortsHandoff({
    episode: episode(), renderArtifact: { ...render(), id: 'old-render' },
  }), /must equal the episode approved render/);
});

test('handoff rejects cross-episode render and invalid segment timing', () => {
  assert.throws(() => createShortsHandoff({
    episode: episode(), renderArtifact: { ...render(), episodeId: 'ep-2' },
  }), /belongs to another episode/);
  assert.throws(() => createShortsHandoff({
    episode: episode(), renderArtifact: render(), candidateSegments: [{ startSeconds: 30, endSeconds: 20 }],
  }), /valid startSeconds\/endSeconds/);
});
