const test = require('node:test');
const assert = require('node:assert/strict');
const { VersionGraph } = require('../src/domain/version-graph');

function graphFixture() {
  const graph = new VersionGraph();
  graph.addVersion({ id: 'script-1', episodeId: 'ep-1', kind: 'script' });
  graph.addVersion({
    id: 'scene-plan-1',
    episodeId: 'ep-1',
    kind: 'scene-plan',
    dependencies: ['script-1'],
  });
  graph.addVersion({
    id: 'scene-a-1',
    episodeId: 'ep-1',
    kind: 'scene',
    dependencies: ['scene-plan-1'],
  });
  graph.addVersion({
    id: 'scene-b-1',
    episodeId: 'ep-1',
    kind: 'scene',
    dependencies: ['scene-plan-1'],
  });
  graph.addVersion({
    id: 'asset-a-1',
    episodeId: 'ep-1',
    kind: 'asset',
    dependencies: ['scene-a-1'],
  });
  graph.addVersion({
    id: 'render-1',
    episodeId: 'ep-1',
    kind: 'render',
    dependencies: ['scene-a-1', 'scene-b-1', 'asset-a-1'],
  });
  return graph;
}

test('stores immutable versions and explicit current selection', () => {
  const graph = graphFixture();
  const version = graph.get('scene-a-1');

  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.payload), true);
  graph.setCurrent('ep-1', 'render-1');
  assert.equal(graph.getCurrent('ep-1').id, 'render-1');
});

test('invalidating a scene only affects its downstream closure', () => {
  const graph = graphFixture();
  const affected = new Set(graph.invalidationPlan(['scene-a-1']).map((v) => v.id));

  assert.deepEqual(affected, new Set(['asset-a-1', 'render-1']));
  assert.equal(affected.has('scene-b-1'), false);
  assert.equal(affected.has('scene-plan-1'), false);
});

test('invalidating a scene plan affects both scenes and their descendants', () => {
  const graph = graphFixture();
  const affected = new Set(graph.invalidationPlan(['scene-plan-1']).map((v) => v.id));

  assert.deepEqual(
    affected,
    new Set(['scene-a-1', 'scene-b-1', 'asset-a-1', 'render-1']),
  );
});

test('rejects cross-episode dependencies', () => {
  const graph = new VersionGraph();
  graph.addVersion({ id: 'scene-1', episodeId: 'ep-1', kind: 'scene' });
  assert.throws(
    () => graph.addVersion({
      id: 'render-2',
      episodeId: 'ep-2',
      kind: 'render',
      dependencies: ['scene-1'],
    }),
    /Cross-episode dependency/,
  );
});

test('rejects unknown dependencies and duplicate version IDs', () => {
  const graph = new VersionGraph();
  assert.throws(
    () => graph.addVersion({ id: 'scene-1', episodeId: 'ep-1', kind: 'scene', dependencies: ['missing'] }),
    /Dependency version does not exist/,
  );
  graph.addVersion({ id: 'scene-1', episodeId: 'ep-1', kind: 'scene' });
  assert.throws(
    () => graph.addVersion({ id: 'scene-1', episodeId: 'ep-1', kind: 'scene' }),
    /Version already exists/,
  );
});

test('setting current version rejects another episode', () => {
  const graph = new VersionGraph();
  graph.addVersion({ id: 'render-1', episodeId: 'ep-1', kind: 'render' });
  assert.throws(() => graph.setCurrent('ep-2', 'render-1'), /does not belong/);
});
