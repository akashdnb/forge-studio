'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { finishingVersionIdentity } = require('../src/media/ship-ready-finishing-handler-sync');

const FIXTURE = Object.freeze({
  finishingConfig: { variants: ['16:9'], captionMode: 'none', thumbnail: false },
  accepted: {
    inputVersionId: 'render:v1',
    artifactId: 'finish-c0e851784286e46f-16x9',
    versionId: 'video-finish-c0e851784286e46f7828b6b0',
    sha256: '20e09f1eb71af61dab91dd836614947ef71d23366a99c34a94f175db7e17f9e5',
  },
  current: {
    inputVersionId: 'render:v2',
    artifactId: 'finish-0a0247319f7c64e3-16x9',
    versionId: 'video-finish-0a0247319f7c64e3ec0283e7',
    sha256: 'dac15fb9fbd600cf81e6bae02061c03552e48890641f841206e4e8448fe520ec',
  },
});

test('release-gate lineage fixture: same finishing config produces distinct immutable identities for v1 and v2', () => {
  const accepted = finishingVersionIdentity(FIXTURE.finishingConfig, FIXTURE.accepted.inputVersionId);
  const current = finishingVersionIdentity(FIXTURE.finishingConfig, FIXTURE.current.inputVersionId);

  assert.equal(accepted.versionId, FIXTURE.accepted.versionId);
  assert.equal(current.versionId, FIXTURE.current.versionId);
  assert.notEqual(accepted.versionId, current.versionId);
  assert.notEqual(accepted.configHash, current.configHash);

  assert.equal(FIXTURE.accepted.sha256, '20e09f1eb71af61dab91dd836614947ef71d23366a99c34a94f175db7e17f9e5');
  assert.equal(FIXTURE.current.sha256, 'dac15fb9fbd600cf81e6bae02061c03552e48890641f841206e4e8448fe520ec');
  assert.notEqual(FIXTURE.accepted.sha256, FIXTURE.current.sha256);
});

test('release-gate lineage fixture: an accepted v1 identity cannot be reused for v2', () => {
  const accepted = finishingVersionIdentity(FIXTURE.finishingConfig, FIXTURE.accepted.inputVersionId);
  const current = finishingVersionIdentity(FIXTURE.finishingConfig, FIXTURE.current.inputVersionId);

  assert.equal(accepted.versionId, 'video-finish-c0e851784286e46f7828b6b0');
  assert.equal(current.versionId, 'video-finish-0a0247319f7c64e3ec0283e7');
  assert.notEqual(accepted.versionId, current.versionId);
});
