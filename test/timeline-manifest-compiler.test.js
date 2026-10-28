const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { compileTimeline, stableJson, COMPILER_VERSION } = require('../src/pipeline/timeline-manifest-compiler');

const versions = {
  t1: { id: 't1', kind: 'timeline' },
  asset1: { id: 'asset1', kind: 'asset' },
  narration1: { id: 'narration1', kind: 'narration' },
};
function timeline(overrides = {}) { return { durationSeconds: 10, inputVersionIds: ['asset1', 'narration1'], tracks: [
  { type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10, assetVersionId: 'asset1', sourcePath: 'assets/a.mp4' }] },
  { type: 'NARRATION', segments: [{ id: 'n1', start: 0, duration: 10, narrationVersionId: 'narration1', sourcePath: 'audio/narration.wav' }] },
], ...overrides }; }

test('compiles valid timeline and calculates duration', () => {
  const result = compileTimeline({ episodeId: 'ep1', timeline: timeline(), versions });
  assert.equal(result.durationSeconds, 10);
  assert.equal(result.compilerVersion, COMPILER_VERSION);
  assert.equal(result.tracks.length, 2);
});

test('preserves visual recipe and shot intent through compilation', () => {
  const shotSpec = {
    shotType: 'DETAIL',
    framing: 'CLOSE',
    cameraMotion: 'PUSH_IN',
    transitionIntent: 'cut',
    continuityAnchors: { subject: 'hero', location: 'lab', palette: 'natural-documentary' },
  };
  const visualRecipe = { recipeVersion: 'visual-recipe-v1', recipeFingerprint: 'recipe-hash' };
  const result = compileTimeline({
    episodeId: 'ep1',
    timeline: timeline({
      visualRecipe,
      tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10, assetVersionId: 'asset1', shotSpec }] }],
    }),
    versions,
  });
  assert.deepEqual(result.tracks[0].segments[0].shotSpec, shotSpec);
  assert.deepEqual(result.visualRecipe, visualRecipe);
  assert.match(result.content, /"shotSpec"/);
  assert.match(result.content, /"visualRecipe"/);
});

test('rejects ordering violations', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'a', start: 2, duration: 5, assetVersionId: 'asset1' }, { id: 'b', start: 1, duration: 2, assetVersionId: 'asset1' }] }] }), versions }), /overlap or are out of order/));

test('rejects overlaps', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'a', start: 0, duration: 5, assetVersionId: 'asset1' }, { id: 'b', start: 4, duration: 6, assetVersionId: 'asset1' }] }] }), versions }), /overlap or are out of order/));

test('rejects missing assets/input versions', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ inputVersionIds: ['asset1', 'missing'] }), versions }), /missing/));

test('rejects provenance-incompatible source kind', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10, assetVersionId: 'narration1' }] }] }), versions }), /VIDEO|source/));

test('rejects narration duration mismatch', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10, assetVersionId: 'asset1' }] }, { type: 'NARRATION', segments: [{ id: 'n1', start: 0, duration: 9, narrationVersionId: 'narration1' }] }] }), versions }), /narration duration/));

test('rejects declared duration mismatch', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ durationSeconds: 11 }), versions }), /duration/));

test('produces byte-identical output for identical inputs', () => {
  const a = compileTimeline({ episodeId: 'ep1', timeline: timeline(), versions });
  const b = compileTimeline({ episodeId: 'ep1', timeline: JSON.parse(JSON.stringify(timeline())), versions: JSON.parse(JSON.stringify(versions)) });
  assert.equal(a.content, b.content);
  assert.equal(a.checksum, b.checksum);
  assert.equal(crypto.createHash('sha256').update(a.content).digest('hex'), crypto.createHash('sha256').update(b.content).digest('hex'));
});

test('stable JSON is key-order independent', () => {
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
});

test('rejects malformed duplicate segment ids', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'same', start: 0, duration: 5, assetVersionId: 'asset1' }, { id: 'same', start: 5, duration: 5, assetVersionId: 'asset1' }] }] }), versions }), /duplicate/));

test('rejects ambiguous missing source provenance', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10 }] }] }), versions }), /immutable source version/));

test('rejects unsupported transition semantics', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 10, assetVersionId: 'asset1', transition: { type: 'fade', duration: 1 } }] }] }), versions }), /unsupported by the deterministic FFmpeg render contract/));

test('supports bounded maximum duration', () => assert.throws(() => compileTimeline({ episodeId: 'ep1', timeline: timeline(), versions, config: { maxDurationSeconds: 9 } }), /maximum duration/));
