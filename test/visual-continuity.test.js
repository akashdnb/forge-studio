const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseScenes, buildContinuity, selectBroll, scoreAssets, buildVisualRecipe, applyRecipeToTimeline, sha256 } = require('../src/visual/visual-continuity');

test('normalises executable shot specifications with deterministic defaults', () => {
  const scenes = normaliseScenes({ scenes: [{ id: 's1', narrationText: 'A scientist explains the process.', location: 'lab', shots: [{ id: 'shot-1', framing: 'CLOSE', duration: 3, visualSubject: 'Dr Rao' }] }] });
  assert.equal(scenes[0].shots[0].shotType, 'A_ROLL');
  assert.equal(scenes[0].shots[0].framing, 'CLOSE');
  assert.equal(scenes[0].shots[0].cameraMotion, 'STATIC');
  assert.equal(scenes[0].shots[0].location, 'lab');
  assert.equal(scenes[0].shots[0].visualSubject.label, 'Dr Rao');
});

test('continuity inherits recurring entity anchors and flags explicit conflicts', () => {
  const result = buildContinuity(normaliseScenes({ scenes: [
    { id: 's1', location: 'lab', wardrobe: 'blue jacket', palette: 'cool', shots: [{ id: 'a', visualSubject: 'Dr Rao' }] },
    { id: 's2', location: 'street', shots: [{ id: 'b', visualSubject: 'Dr Rao' }] },
  ] }));
  assert.equal(result.scenes[1].shots[0].location, 'lab');
  assert.ok(result.warnings.some((warning) => warning.code === 'CONTINUITY_CONFLICT' && warning.field === 'location'));
});

test('continuity allows intentional breaks', () => {
  const result = buildContinuity(normaliseScenes({ scenes: [
    { id: 's1', location: 'lab', shots: [{ id: 'a', visualSubject: 'Dr Rao' }] },
    { id: 's2', location: 'street', continuityBreak: true, shots: [{ id: 'b', visualSubject: 'Dr Rao' }] },
  ] }));
  assert.equal(result.scenes[1].shots[0].location, 'street');
  assert.equal(result.warnings.length, 0);
});

test('b-roll scoring prefers semantic, role and continuity matches and avoids repetition', () => {
  const assets = [
    { id: 'lab-detail', role: 'DETAIL', description: 'close up of laboratory equipment', location: 'lab', tags: ['process'] },
    { id: 'random-landscape', role: 'ESTABLISHING', description: 'mountain landscape', location: 'mountain' },
  ];
  const requirement = { narrationText: 'the process uses laboratory equipment', intent: 'show process', roles: ['DETAIL'], location: 'lab', durationSeconds: 4 };
  const ranked = scoreAssets(assets, requirement);
  assert.equal(ranked[0].id, 'lab-detail');
  assert.ok(ranked[0].score > ranked[1].score);
  const selections = selectBroll({ scenes: [{ id: 's1', narrationText: requirement.narrationText, intent: requirement.intent, shots: [{ id: 'shot', shotType: 'B_ROLL', durationSeconds: 4, location: 'lab' }] }], assets });
  assert.equal(selections[0].selectedAssetId, 'lab-detail');
});

test('b-roll has durable fallback when no candidate is suitable', () => {
  const selections = selectBroll({ scenes: [{ id: 's1', narrationText: 'a very specific event', shots: [{ id: 'shot', shotType: 'B_ROLL', durationSeconds: 4 }] }], assets: [] });
  assert.equal(selections[0].selectedAssetId, null);
  assert.deepEqual(selections[0].fallback.order, ['preferred-existing', 'provider-generated', 'continuity-compatible-prior', 'neutral-establishing']);
  assert.equal(selections[0].fallback.retryableProviderFailure, true);
});

test('visual recipe is deterministic for identical inputs', () => {
  const input = { episodeId: 'ep1', scenePlanVersionId: 'scene-plan:1', plan: { scenes: [{ id: 's1', narrationText: 'A volcano erupts.', location: 'mountain', shots: [{ id: 'shot-1', shotType: 'ESTABLISHING', duration: 5 }] }] }, assets: [{ id: 'asset-1', versionId: 'asset-1', contentHash: 'abc', role: 'ESTABLISHING', description: 'volcano mountain' }], narrationVersionIds: ['n1'] };
  const a = buildVisualRecipe(input);
  const b = buildVisualRecipe(JSON.parse(JSON.stringify(input)));
  assert.equal(a.recipeFingerprint, b.recipeFingerprint);
  assert.equal(sha256(a), sha256(b));
});

test('timeline application turns selected b-roll into renderable asset provenance', () => {
  const recipe = buildVisualRecipe({ episodeId: 'ep1', scenePlanVersionId: 'sp1', plan: { scenes: [{ id: 's1', narrationText: 'A process is shown.', shots: [{ id: 'shot-1', shotType: 'B_ROLL', duration: 4, location: 'lab' }] }] }, assets: [{ id: 'asset-1', versionId: 'asset-v1', contentHash: 'hash', role: 'PROCESS', description: 'laboratory process', location: 'lab' }] });
  const applied = applyRecipeToTimeline({ durationSeconds: 4, tracks: [{ type: 'VIDEO', segments: [{ id: 'shot-1', start: 0, duration: 4, assetVersionId: 'old-v1' }] }] }, recipe, new Map([['asset-1', { id: 'asset-1', versionId: 'asset-v1' }]]));
  assert.equal(applied.tracks[0].segments[0].assetVersionId, 'asset-v1');
  assert.equal(applied.visualRecipe.recipeFingerprint, recipe.recipeFingerprint);
});
