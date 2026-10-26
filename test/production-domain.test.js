const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EpisodeService, ArtifactRegistry, ProviderRunLedger, ApprovalService, QAService, ProductionService,
} = require('../src');

test('episode lifecycle enforces transitions and optimistic revision checks', () => {
  const service = new EpisodeService();
  const episode = service.create({ id: 'ep-1', projectId: 'project-1', title: 'How volcanoes work' });
  assert.equal(episode.state, 'DRAFT');
  assert.throws(() => service.transition('ep-1', 'PUBLISHED'), /Illegal episode transition/);
  const researching = service.transition('ep-1', 'RESEARCHING', { expectedRevision: 1 });
  assert.equal(researching.revision, 2);
  assert.throws(() => service.transition('ep-1', 'SCRIPT_DRAFT', { expectedRevision: 1 }), /revision conflict/);
});

test('episode, artifact and metadata records are deeply immutable snapshots', () => {
  const episodes = new EpisodeService();
  const episode = episodes.create({ id: 'ep-1', projectId: 'p', title: 'Title', metadata: { styles: { palette: ['blue'] } } });
  assert.ok(Object.isFrozen(episode.metadata.styles.palette));
  assert.throws(() => { episode.metadata.styles.palette.push('red'); }, TypeError);
  const artifacts = new ArtifactRegistry();
  const artifact = artifacts.register({ id: 'a1', episodeId: 'ep-1', kind: 'script', versionId: 's1', content: { sections: [{ text: 'hello' }] } });
  assert.ok(Object.isFrozen(artifact.content.sections[0]));
  assert.throws(() => { artifact.content.sections[0].text = 'tampered'; }, TypeError);
  assert.equal(artifacts.verifyContent('a1', { sections: [{ text: 'hello' }] }).valid, true);
  assert.equal(artifacts.verifyContent('a1', { sections: [{ text: 'changed' }] }).valid, false);
});

test('artifact registry enforces unique ids and requires durable content or location', () => {
  const registry = new ArtifactRegistry();
  assert.throws(() => registry.register({ id: 'a1', episodeId: 'ep', kind: 'asset', versionId: 'v1' }), /storageUri or content/);
  registry.register({ id: 'a1', episodeId: 'ep', kind: 'asset', versionId: 'v1', storageUri: 's3://bucket/a1' });
  assert.throws(() => registry.register({ id: 'a1', episodeId: 'ep', kind: 'asset', versionId: 'v2', storageUri: 's3://bucket/a2' }), /already exists/);
});

test('provider runs are idempotent and terminal records cannot be mutated', () => {
  const ledger = new ProviderRunLedger();
  const run = ledger.start({ id: 'run-1', episodeId: 'ep-1', capability: 'tts', provider: 'fake', idempotencyKey: 'tts:v1' });
  const duplicate = ledger.start({ id: 'run-2', episodeId: 'ep-1', capability: 'tts', provider: 'other', idempotencyKey: 'tts:v1' });
  assert.equal(duplicate.id, run.id);
  ledger.transition('run-1', 'RUNNING', { externalJobId: 'ext-1' });
  ledger.transition('run-1', 'SUCCEEDED', { resultArtifactIds: ['audio-1'], usage: { chars: 42 } });
  assert.throws(() => ledger.transition('run-1', 'FAILED'), /Terminal provider runs are immutable/);
});

test('cost ledger validates ownership, units and currency-scoped aggregation', () => {
  const ledger = new ProviderRunLedger();
  ledger.start({ id: 'r1', episodeId: 'ep-1', capability: 'image', provider: 'fake', idempotencyKey: 'image:v1' });
  ledger.recordCost({ id: 'c1', runId: 'r1', episodeId: 'ep-1', provider: 'fake', operation: 'image', estimatedCost: 0.2, actualCost: 0.17 });
  ledger.recordCost({ id: 'c2', runId: 'r1', episodeId: 'ep-1', provider: 'fake', operation: 'image', currency: 'INR', actualCost: 10 });
  assert.deepEqual(ledger.episodeCost('ep-1').currencies.USD, { estimated: 0.2, actual: 0.17, estimatedRecords: 1, actualRecords: 1 });
  assert.equal(ledger.episodeCost('ep-1').currencies.INR.actual, 10);
  assert.throws(() => ledger.recordCost({ id: 'bad', runId: 'r1', episodeId: 'ep-2', provider: 'fake', operation: 'image' }), /must match provider run/);
  assert.throws(() => ledger.recordCost({ id: 'bad2', runId: 'r1', episodeId: 'ep-1', provider: 'fake', operation: 'image', actualCost: -1 }), /non-negative/);
});

test('approval is scoped to the exact immutable target version and newer decisions supersede', () => {
  const approvals = new ApprovalService();
  approvals.decide({ id: 'ap1', episodeId: 'ep-1', stage: 'SCRIPT', targetId: 'script', targetVersionId: 's1', decision: 'APPROVED', actor: 'reviewer' });
  assert.equal(approvals.isApproved({ episodeId: 'ep-1', stage: 'SCRIPT', targetId: 'script', targetVersionId: 's1' }), true);
  assert.equal(approvals.isApproved({ episodeId: 'ep-1', stage: 'SCRIPT', targetId: 'script', targetVersionId: 's2' }), false);
  approvals.decide({ id: 'ap2', episodeId: 'ep-1', stage: 'SCRIPT', targetId: 'script', targetVersionId: 's2', decision: 'CHANGES_REQUESTED', actor: 'reviewer' });
  assert.equal(approvals.isApproved({ episodeId: 'ep-1', stage: 'SCRIPT', targetId: 'script', targetVersionId: 's1' }), false);
});

test('QA gates approval and stale QA cannot approve a newer version', () => {
  const qa = new QAService();
  qa.record({ id: 'q1', episodeId: 'ep-1', artifactId: 'render-a', versionId: 'render-v1', checks: [{ name: 'has-audio', status: 'PASS' }] });
  assert.equal(qa.canApprove('render-a', 'render-v1'), true);
  assert.equal(qa.canApprove('render-a', 'render-v2'), false);
  qa.record({ id: 'q2', episodeId: 'ep-1', artifactId: 'render-b', versionId: 'render-v1', checks: [{ name: 'audio', status: 'FAIL' }] });
  assert.equal(qa.canApprove('render-b', 'render-v1'), false);
});

test('production facade only approves selected render with current QA and provenance', () => {
  const service = new ProductionService();
  service.episodes.create({ id: 'ep-1', projectId: 'p', title: 'Demo' });
  for (const state of ['SCRIPT_DRAFT','SCRIPT_REVIEW','SCRIPT_APPROVED','PLANNING','PLAN_REVIEW','GENERATION','READY_TO_RENDER','RENDERING','QA','AWAITING_APPROVAL']) service.episodes.transition('ep-1', state);
  service.artifacts.register({ id: 'render-a', episodeId: 'ep-1', kind: 'render', versionId: 'render-v1', storageUri: 's3://renders/a.mp4' });
  service.episodes.selectRender('ep-1', 'render-a');
  service.qa.record({ id: 'qa-a', episodeId: 'ep-1', artifactId: 'render-a', versionId: 'render-v1', checks: [{ name: 'duration', status: 'PASS' }] });
  assert.throws(() => service.approveFinalRender({ approvalId: 'ap-a', episodeId: 'ep-1', renderArtifactId: 'render-a', renderVersionId: 'render-v2', actor: 'user' }), /provenance mismatch/);
  const result = service.approveFinalRender({ approvalId: 'ap-b', episodeId: 'ep-1', renderArtifactId: 'render-a', renderVersionId: 'render-v1', actor: 'user' });
  assert.equal(result.episode.state, 'APPROVED');
  assert.equal(result.episode.approvedRenderId, 'render-a');
});
