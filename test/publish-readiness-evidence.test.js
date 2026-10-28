'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertFreshQaEvidence } = require('../src/publishing/publish-readiness-evidence');

const NOW = new Date('2026-10-28T10:00:00.000Z');
const BASE_RUN = { render_artifact_id: 'render-new', render_version_id: 'version-new', content_hash: 'b'.repeat(64) };
const BASE_GATE = { status: 'READY_TO_SHIP', qaId: 'qa-new', configHash: 'config-new', artifactIds: ['render-new'] };

function qa(overrides = {}) {
  return {
    id: 'qa-new',
    status: 'PASSED',
    artifact_id: 'render-new',
    version_id: 'version-new',
    created_at: '2026-10-28T09:55:00.000Z',
    metadata: {
      jobId: 'job-new',
      attempt: 2,
      artifactSha256: 'b'.repeat(64),
      provenance: { renderArtifactId: 'render-new', renderVersionId: 'version-new' },
    },
    ...overrides,
  };
}

test('old QA for a previous artifact cannot satisfy new publish artifact', () => {
  assert.throws(() => assertFreshQaEvidence({
    gate: { ...BASE_GATE, qaId: 'qa-old', artifactIds: ['render-new'] },
    qa: qa({ id: 'qa-old', artifact_id: 'render-old', version_id: 'version-old', metadata: { ...qa().metadata, artifactSha256: 'a'.repeat(64), provenance: { renderArtifactId: 'render-old', renderVersionId: 'version-old' } } }),
    run: BASE_RUN,
    now: NOW,
  }), /superseded|different artifact|different artifact\/version/);
});

test('late QA event cannot overwrite a newer persisted QA result', () => {
  assert.throws(() => assertFreshQaEvidence({
    gate: { ...BASE_GATE, qaId: 'qa-old' },
    qa: qa({ id: 'qa-new', created_at: '2026-10-28T09:59:00.000Z', metadata: { ...qa().metadata, jobId: 'job-newer', attempt: 2 } }),
    run: BASE_RUN,
    now: NOW,
  }), /superseded/);
});

test('expired QA evidence is rejected even when artifact and checksum still match', () => {
  assert.throws(() => assertFreshQaEvidence({
    gate: BASE_GATE,
    qa: qa({ created_at: '2026-10-27T09:59:59.999Z' }),
    run: BASE_RUN,
    now: NOW,
    freshnessMs: 24 * 60 * 60 * 1000,
  }), /expired/);
});

test('newer QA result supersedes an older gate reference', () => {
  assert.throws(() => assertFreshQaEvidence({
    gate: { ...BASE_GATE, qaId: 'qa-old' },
    qa: qa({ id: 'qa-new' }),
    run: BASE_RUN,
    now: NOW,
  }), /superseded/);
});

test('fresh QA requires exact artifact, version, checksum and evidence identity', () => {
  assert.equal(assertFreshQaEvidence({ gate: BASE_GATE, qa: qa(), run: BASE_RUN, now: NOW }), true);
  assert.throws(() => assertFreshQaEvidence({ gate: BASE_GATE, qa: qa({ metadata: { ...qa().metadata, artifactSha256: 'c'.repeat(64) } }), run: BASE_RUN, now: NOW }), /checksum/);
});

test('deterministic final QA can use its persisted QA id as evidence identity', () => {
  const deterministicQa = qa({ metadata: { artifactRefs: [{ variant: '16:9', checksum: 'b'.repeat(64) }] } });
  assert.equal(assertFreshQaEvidence({ gate: BASE_GATE, qa: deterministicQa, run: BASE_RUN, now: NOW }), true);
});
