'use strict';

const crypto = require('node:crypto');

const RECIPE_VERSION = 'visual-recipe-v1';
const SHOT_TYPES = new Set(['A_ROLL','B_ROLL','ESTABLISHING','DETAIL','CUTAWAY','SCREEN','ARCHIVAL','MONTAGE']);
const FRAMINGS = new Set(['WIDE','MEDIUM_WIDE','MEDIUM','MEDIUM_CLOSE','CLOSE','EXTREME_CLOSE','OVERHEAD','POV','TWO_SHOT']);
const MOTIONS = new Set(['STATIC','PUSH_IN','PULL_OUT','PAN','TILT','DOLLY','TRACK','HANDHELD','ORBIT','PARALLAX']);
const LIGHTING = new Set(['NATURAL','SOFT','HIGH_KEY','LOW_KEY','DRAMATIC','NEUTRAL','WARM','COOL']);
const STOPWORDS = new Set('a an and are as at be by for from in into is it of on or that the their this to with you your we our how why what when where which'.split(' '));
const BROLL_RULES = [
  { pattern: /\b(map|location|country|city|region|geograph|where)\b/i, roles: ['MAP','ESTABLISHING'], shotType: 'ESTABLISHING' },
  { pattern: /\b(example|case|instance|story|person|people|scientist|researcher|expert)\b/i, roles: ['SUBJECT','PORTRAIT','ARCHIVAL'], shotType: 'B_ROLL' },
  { pattern: /\b(process|step|build|make|work|mechanism|how)\b/i, roles: ['PROCESS','DETAIL','SCREEN'], shotType: 'B_ROLL' },
  { pattern: /\b(data|number|percent|chart|graph|trend|statistics)\b/i, roles: ['DATA','SCREEN','CHART'], shotType: 'SCREEN' },
  { pattern: /\b(history|historic|ancient|past|archive|century)\b/i, roles: ['ARCHIVAL','HISTORY'], shotType: 'ARCHIVAL' },
  { pattern: /\b(object|tool|device|material|detail|close)\b/i, roles: ['OBJECT','DETAIL'], shotType: 'DETAIL' },
  { pattern: /\b(environment|landscape|building|room|street|forest|ocean|volcano|mountain)\b/i, roles: ['ENVIRONMENT','ESTABLISHING'], shotType: 'ESTABLISHING' },
];

function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function tokens(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean).filter((word) => !STOPWORDS.has(word)))];
}
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null && value !== ''); }
function normaliseSubject(value) {
  if (!value) return null;
  if (typeof value === 'string') return { entityId: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label: value };
  const label = firstDefined(value.label, value.name, value.entity, value.id);
  return label ? { entityId: firstDefined(value.entityId, value.id, String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')), label: String(label) } : null;
}
function sceneNarration(scene) { return String(firstDefined(scene.narrationText, scene.narration, scene.voiceover, scene.description, scene.summary, '') || ''); }
function sceneIntent(scene) { return String(firstDefined(scene.intent, scene.visualIntent, scene.purpose, '') || ''); }
function inferBrollRule(text) { return BROLL_RULES.find((rule) => rule.pattern.test(text)) || { roles: ['CONTEXT','B_ROLL'], shotType: 'B_ROLL' }; }
function normaliseShot(raw, scene, index, previous) {
  const subject = normaliseSubject(firstDefined(raw.visualSubject, raw.subject, raw.entity, scene.visualSubject, scene.subject));
  const shot = {
    id: String(firstDefined(raw.id, raw.shotId, `${scene.id || `scene-${index + 1}`}-shot-${index + 1}`)),
    shotType: SHOT_TYPES.has(String(firstDefined(raw.shotType, raw.type, '')).toUpperCase()) ? String(firstDefined(raw.shotType, raw.type)).toUpperCase() : (index === 0 ? 'A_ROLL' : 'B_ROLL'),
    framing: FRAMINGS.has(String(firstDefined(raw.framing, raw.composition, '')).toUpperCase()) ? String(firstDefined(raw.framing, raw.composition)).toUpperCase() : 'MEDIUM',
    cameraMotion: MOTIONS.has(String(firstDefined(raw.cameraMotion, raw.motion, raw.camera, '')).toUpperCase()) ? String(firstDefined(raw.cameraMotion, raw.motion, raw.camera)).toUpperCase() : 'STATIC',
    durationSeconds: Math.max(0.25, Number(firstDefined(raw.durationSeconds, raw.duration, 4))),
    narrationAlignment: firstDefined(raw.narrationAlignment, raw.alignment, { start: 0, end: null }),
    visualSubject: subject,
    location: firstDefined(raw.location, scene.location, previous?.location, null),
    style: firstDefined(raw.style, scene.style, previous?.style, 'documentary'),
    lighting: LIGHTING.has(String(firstDefined(raw.lighting, scene.lighting, previous?.lighting, '')).toUpperCase()) ? String(firstDefined(raw.lighting, scene.lighting, previous?.lighting)).toUpperCase() : firstDefined(raw.lighting, scene.lighting, previous?.lighting, 'NATURAL'),
    continuityAnchors: { ...(previous?.continuityAnchors || {}), ...(scene.continuityAnchors || {}), ...(raw.continuityAnchors || {}) },
    brollCoverage: asArray(firstDefined(raw.brollCoverage, raw.coverage, scene.brollCoverage)),
    transitionIntent: firstDefined(raw.transitionIntent, raw.transition, scene.transitionIntent, 'cut'),
    assetSuitabilityRequirements: { ...(scene.assetSuitabilityRequirements || {}), ...(raw.assetSuitabilityRequirements || {}) },
  };
  if (!shot.continuityAnchors.palette) shot.continuityAnchors.palette = firstDefined(scene.palette, previous?.continuityAnchors?.palette, 'natural-documentary');
  if (!shot.continuityAnchors.composition) shot.continuityAnchors.composition = shot.framing;
  if (subject) shot.continuityAnchors.subject = subject.entityId;
  return shot;
}

function normaliseScenes(plan) {
  const root = plan?.scenePlan || plan?.plan || plan || {};
  const scenes = asArray(root.scenes?.length ? root.scenes : root.sceneList?.length ? root.sceneList : root.sequence);
  if (!scenes.length && Array.isArray(root.shots)) return [{ id: 'scene-1', narrationText: root.narrationText || '', intent: root.intent || '', shots: root.shots }];
  return scenes.map((scene, index) => ({ ...scene, id: String(firstDefined(scene.id, scene.sceneId, `scene-${index + 1}`)), shots: asArray(scene.shots?.length ? scene.shots : scene.shotList?.length ? scene.shotList : scene.coverage) }));
}

function buildContinuity(scenes) {
  const entityState = new Map();
  const locationState = new Map();
  const warnings = [];
  const result = [];
  for (const scene of scenes) {
    let previousShot = result.at(-1)?.shots?.at(-1) || null;
    const shots = scene.shots.map((raw, index) => {
      const subject = normaliseSubject(firstDefined(raw.visualSubject, raw.subject, raw.entity, scene.visualSubject, scene.subject));
      const state = subject ? entityState.get(subject.entityId) : null;
      const location = firstDefined(raw.location, scene.location, state?.location, previousShot?.location);
      const continuityBreak = Boolean(raw.continuityBreak || scene.continuityBreak);
      if (state && !continuityBreak) {
        for (const key of ['location','style','lighting','wardrobe','palette']) {
          const explicit = firstDefined(raw[key], scene[key]);
          if (explicit && state[key] && String(explicit) !== String(state[key])) warnings.push({ code: 'CONTINUITY_CONFLICT', sceneId: scene.id, shotId: raw.id || null, entityId: subject.entityId, field: key, expected: state[key], actual: explicit });
        }
      }
      const shot = normaliseShot(raw, scene, index, state || previousShot);
      if (subject && state && !continuityBreak) {
        shot.location = state.location || shot.location;
        shot.style = state.style || shot.style;
        shot.lighting = state.lighting || shot.lighting;
        shot.continuityAnchors = { ...shot.continuityAnchors, wardrobe: state.wardrobe || shot.continuityAnchors.wardrobe, palette: state.palette || shot.continuityAnchors.palette };
      }
      const nextState = { location: shot.location, style: shot.style, lighting: shot.lighting, wardrobe: firstDefined(raw.wardrobe, scene.wardrobe, state?.wardrobe, null), palette: shot.continuityAnchors.palette };
      if (subject) entityState.set(subject.entityId, nextState);
      if (location) locationState.set(String(location), nextState);
      previousShot = shot;
      return shot;
    });
    result.push({ ...scene, shots });
  }
  return { scenes: result, warnings, anchors: Object.fromEntries([...entityState.entries()].sort(([a],[b]) => a.localeCompare(b))) };
}

function candidateScore(candidate, requirement, usedIds = new Set(), priorShot = null) {
  const haystack = tokens([candidate.description, candidate.prompt, candidate.subject, candidate.location, ...(candidate.tags || []), candidate.role].join(' '));
  const wanted = tokens([requirement.narrationText, requirement.intent, requirement.location, ...(requirement.roles || [])].join(' '));
  const overlap = wanted.length ? wanted.filter((word) => haystack.includes(word)).length / wanted.length : 0;
  const role = requirement.roles?.some((r) => String(candidate.role || '').toUpperCase() === String(r).toUpperCase()) ? 1 : 0;
  const continuity = priorShot && candidate.location && priorShot.location && String(candidate.location) === String(priorShot.location) ? 1 : 0.5;
  const duration = candidate.durationSeconds ? Math.min(1, Number(candidate.durationSeconds) / Math.max(0.25, requirement.durationSeconds || 1)) : 0.5;
  const repetitionPenalty = usedIds.has(candidate.id) ? 1 : 0;
  return Number((overlap * 0.45 + role * 0.2 + continuity * 0.15 + duration * 0.1 - repetitionPenalty * 0.1).toFixed(6));
}

function selectBroll({ scenes, assets = [] }) {
  const used = new Set();
  const selections = [];
  for (const scene of scenes) {
    const narrationText = sceneNarration(scene);
    const intent = sceneIntent(scene);
    const rule = inferBrollRule(`${narrationText} ${intent}`);
    for (const shot of scene.shots) {
      if (!['B_ROLL','CUTAWAY','DETAIL','ESTABLISHING','SCREEN','ARCHIVAL','MONTAGE'].includes(shot.shotType) && !shot.brollCoverage.length) continue;
      const requirement = { narrationText, intent, location: shot.location, roles: [...rule.roles, ...shot.brollCoverage], durationSeconds: shot.durationSeconds };
      const ranked = assets.map((asset) => ({ asset, score: candidateScore(asset, requirement, used, shot) })).sort((a, b) => b.score - a.score || String(a.asset.id).localeCompare(String(b.asset.id)));
      const best = ranked.find((entry) => entry.score >= 0.2 && !used.has(entry.asset.id)) || ranked.find((entry) => entry.score >= 0.15) || null;
      const selection = { sceneId: scene.id, shotId: shot.id, requirement, rule: rule.roles, selectedAssetId: best?.asset.id || null, suitabilityScore: best?.score || 0, ranked: ranked.slice(0, 5).map((entry) => ({ assetId: entry.asset.id, score: entry.score })) };
      if (best) used.add(best.asset.id);
      else selection.fallback = { order: ['preferred-existing','provider-generated','continuity-compatible-prior','neutral-establishing'], retryableProviderFailure: true, neutralStyle: shot.style, reason: 'NO_SUITABLE_ASSET' };
      selections.push(selection);
    }
  }
  return selections;
}

function buildVisualRecipe({ episodeId, scenePlanVersionId, plan, assets = [], narrationVersionIds = [] }) {
  const scenes = normaliseScenes(plan);
  const continuity = buildContinuity(scenes);
  const broll = selectBroll({ scenes: continuity.scenes, assets });
  const recipeInput = { episodeId, scenePlanVersionId, plan, assets: assets.map((asset) => ({ id: asset.id, versionId: asset.versionId, contentHash: asset.contentHash, metadata: asset.metadata || {} })), narrationVersionIds };
  return {
    recipeVersion: RECIPE_VERSION,
    recipeFingerprint: sha256(recipeInput),
    deterministicInputs: { scenePlanVersionId, narrationVersionIds: [...narrationVersionIds].sort(), assetIds: assets.map((a) => a.id).sort() },
    scenes: continuity.scenes,
    continuity: { anchors: continuity.anchors, warnings: continuity.warnings },
    broll,
    fallbackPolicy: { preferred: 'existing-approved', generated: 'configured-provider', continuityCompatible: true, final: 'neutral-establishing', retryableProviderFailure: true },
  };
}

function scoreAssets(assets, requirement) {
  return assets.map((asset) => ({ id: asset.id, versionId: asset.versionId, score: candidateScore(asset, requirement), reason: { semantic: tokens([asset.description, asset.prompt, asset.subject, ...(asset.tags || [])].join(' ')).filter((t) => tokens(requirement.narrationText).includes(t)).length, role: asset.role || null, continuity: asset.location === requirement.location ? 1 : 0 }, contentHash: asset.contentHash || null })).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

function applyRecipeToTimeline(timeline, recipe, assetById = new Map()) {
  const next = JSON.parse(JSON.stringify(timeline));
  const brollByShot = new Map(recipe.broll.map((entry) => [entry.shotId, entry]));
  const shotById = new Map(recipe.scenes.flatMap((scene) => scene.shots.map((shot) => [shot.id, shot])));
  for (const track of next.tracks || []) {
    for (const segment of track.segments || []) {
      const shot = shotById.get(segment.shotId || segment.id);
      if (!shot) continue;
      segment.shotSpec = { shotType: shot.shotType, framing: shot.framing, cameraMotion: shot.cameraMotion, durationSeconds: shot.durationSeconds, narrationAlignment: shot.narrationAlignment, transitionIntent: shot.transitionIntent, continuityAnchors: shot.continuityAnchors };
      const broll = brollByShot.get(shot.id);
      if (broll?.selectedAssetId && assetById.has(broll.selectedAssetId) && track.type === 'VIDEO') {
        segment.assetVersionId = assetById.get(broll.selectedAssetId).versionId;
        segment.assetSuitabilityScore = broll.suitabilityScore;
      } else if (broll?.fallback) segment.fallback = broll.fallback;
    }
  }
  next.visualRecipe = { recipeVersion: recipe.recipeVersion, recipeFingerprint: recipe.recipeFingerprint };
  next.inputVersionIds = [...new Set([...(next.inputVersionIds || []), ...recipe.deterministicInputs.assetIds, recipe.scenePlanVersionId])].sort();
  return next;
}

module.exports = { RECIPE_VERSION, stableJson, sha256, normaliseScenes, buildContinuity, selectBroll, scoreAssets, buildVisualRecipe, applyRecipeToTimeline, inferBrollRule };
