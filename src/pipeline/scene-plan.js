const { requiredString } = require('../domain/records');

const SCENE_TYPES = Object.freeze(['narration', 'title-card', 'diagram', 'animation', 'footage', 'image', 'code', 'transition']);

function validateScenePlan(plan, { maxDurationSeconds = 3600, minDurationSeconds = 0.25 } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { valid: false, errors: [{ path: '$', message: 'Scene plan must be an object' }] };
  }
  if (plan.schemaVersion !== '1.0') errors.push({ path: '$.schemaVersion', message: 'schemaVersion must be "1.0"' });
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    errors.push({ path: '$.scenes', message: 'At least one scene is required' });
    return { valid: false, errors };
  }
  let total = 0;
  const ids = new Set();
  plan.scenes.forEach((scene, index) => {
    const path = `$.scenes[${index}]`;
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      errors.push({ path, message: 'Scene must be an object' });
      return;
    }
    if (typeof scene.id !== 'string' || !scene.id.trim()) errors.push({ path: `${path}.id`, message: 'Scene id is required' });
    else if (ids.has(scene.id)) errors.push({ path: `${path}.id`, message: `Duplicate scene id: ${scene.id}` });
    else ids.add(scene.id);
    if (typeof scene.title !== 'string' || !scene.title.trim()) errors.push({ path: `${path}.title`, message: 'Scene title is required' });
    if (!SCENE_TYPES.includes(scene.type)) errors.push({ path: `${path}.type`, message: `type must be one of: ${SCENE_TYPES.join(', ')}` });
    if (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds < minDurationSeconds) {
      errors.push({ path: `${path}.durationSeconds`, message: `durationSeconds must be at least ${minDurationSeconds}` });
    } else total += scene.durationSeconds;
    if (scene.narration !== undefined && typeof scene.narration !== 'string') {
      errors.push({ path: `${path}.narration`, message: 'narration must be a string when provided' });
    }
    if (scene.visual !== undefined && (!scene.visual || typeof scene.visual !== 'object' || Array.isArray(scene.visual))) {
      errors.push({ path: `${path}.visual`, message: 'visual must be an object when provided' });
    }
    if (scene.assetIds !== undefined && (!Array.isArray(scene.assetIds) || scene.assetIds.some((id) => typeof id !== 'string' || !id.trim()))) {
      errors.push({ path: `${path}.assetIds`, message: 'assetIds must be an array of non-empty strings' });
    }
    if (scene.startSeconds !== undefined && (!Number.isFinite(scene.startSeconds) || scene.startSeconds < 0)) {
      errors.push({ path: `${path}.startSeconds`, message: 'startSeconds must be a non-negative finite number' });
    }
  });
  if (Number.isFinite(plan.totalDurationSeconds) && Math.abs(plan.totalDurationSeconds - total) > 0.05) {
    errors.push({ path: '$.totalDurationSeconds', message: 'totalDurationSeconds does not match scene durations' });
  }
  if (total > maxDurationSeconds) errors.push({ path: '$.scenes', message: `Total duration exceeds ${maxDurationSeconds} seconds` });
  return { valid: errors.length === 0, errors, sceneCount: plan.scenes.length, totalDurationSeconds: total };
}

function normalizeScenePlan(plan, options) {
  const validation = validateScenePlan(plan, options);
  if (!validation.valid) {
    const error = new TypeError('Invalid scene plan');
    error.validationErrors = validation.errors;
    throw error;
  }
  const scenes = plan.scenes.map((scene) => ({
    id: requiredString(scene.id, 'scene.id'),
    title: requiredString(scene.title, 'scene.title'),
    type: scene.type,
    durationSeconds: scene.durationSeconds,
    narration: scene.narration || '',
    visual: scene.visual || {},
    assetIds: [...new Set(scene.assetIds || [])],
    startSeconds: scene.startSeconds,
  }));
  let cursor = 0;
  for (const scene of scenes) {
    if (scene.startSeconds === undefined) scene.startSeconds = cursor;
    cursor = Math.max(cursor, scene.startSeconds + scene.durationSeconds);
  }
  return {
    schemaVersion: '1.0',
    episodeId: plan.episodeId || null,
    title: plan.title || '',
    scenes,
    totalDurationSeconds: validation.totalDurationSeconds,
  };
}

module.exports = { SCENE_TYPES, validateScenePlan, normalizeScenePlan };
