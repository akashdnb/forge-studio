const test = require('node:test');
const assert = require('node:assert/strict');
const { validateResearchPackage, validateTimeline, validatePublishRequest } = require('../src/pipeline/production-contracts');

test('research packages require traceable sources and claims and preserve package metadata', () => {
  const result = validateResearchPackage({ status: 'REVIEWED', notes: 'Reviewed manually', sources: [{ id: 's1', url: 'https://example.com/source' }], claims: [{ id: 'c1', claim: 'Fact', sourceIds: ['s1', 's1'] }] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.claims[0].sourceIds.length, 1);
  assert.equal(result.status, 'REVIEWED');
  assert.equal(result.notes, 'Reviewed manually');
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.throws(() => validateResearchPackage({ claims: [{ id: 'c1', claim: 'Fact', sourceIds: ['missing'] }] }), /unknown source/);
  assert.throws(() => validateResearchPackage({ sources: [{ id: 's1', url: 'https://example.com/a' }, { id: 's1', url: 'https://example.com/b' }] }), /duplicate research source/);
});

test('timeline validation rejects overlaps and produces a content hash', () => {
  const result = validateTimeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'a', start: 0, duration: 5 }, { id: 'b', start: 5, duration: 2 }] }], durationSeconds: 7 });
  assert.equal(result.durationSeconds, 7);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.throws(() => validateTimeline({ tracks: [{ type: 'VIDEO', segments: [{ id: 'a', start: 0, duration: 5 }, { id: 'b', start: 4, duration: 2 }] }], durationSeconds: 6 }), /overlap/);
});

test('publish validation requires the exact approved render, passing QA, and implemented destination', () => {
  const result = validatePublishRequest({ episode: { state: 'APPROVED', approvedRenderId: 'r1' }, renderArtifact: { id: 'r1' }, qaStatus: 'PASSED', metadata: { title: 'Test' } });
  assert.equal(result.destination, 'youtube');
  assert.throws(() => validatePublishRequest({ episode: { state: 'APPROVED', approvedRenderId: 'r1' }, renderArtifact: { id: 'r2' }, qaStatus: 'PASSED', metadata: { title: 'Test' } }), /approved render/);
  assert.throws(() => validatePublishRequest({ episode: { state: 'APPROVED', approvedRenderId: 'r1' }, renderArtifact: { id: 'r1' }, qaStatus: 'PASSED', metadata: { title: 'Test', destination: 'vimeo' } }), /Only YouTube/);
});
