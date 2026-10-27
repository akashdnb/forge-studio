'use strict';

const crypto = require('node:crypto');
const visual = require('./visual-continuity');

function hash(value) { return crypto.createHash('sha256').update(visual.stableJson(value)).digest('hex'); }
function contentHash(value) { return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(value))).digest('hex'); }
function payloadFromVersion(row) { return row?.payload?.scenePlan || row?.payload?.plan || row?.payload || {}; }

async function loadScenePlan(pool, episodeId, inputVersionIds = []) {
  const rows = await pool.query('SELECT id,kind,payload,content_hash FROM version_records WHERE episode_id=$1 AND id=ANY($2::text[])', [episodeId, inputVersionIds]);
  return rows.rows.find((row) => row.kind === 'scene-plan') || null;
}
async function loadAssets(pool, episodeId) {
  const result = await pool.query(`SELECT id,version_id,content_hash,media_type,metadata,content_json FROM artifacts WHERE episode_id=$1 AND kind IN ('image','video','asset') ORDER BY created_at ASC,id ASC`, [episodeId]);
  return result.rows.map((row) => ({
    id: row.id, versionId: row.version_id, contentHash: row.content_hash, mediaType: row.media_type, metadata: row.metadata || {},
    description: row.metadata?.description || row.content_json?.description || '', prompt: row.metadata?.prompt || row.content_json?.prompt || '', subject: row.metadata?.subject || row.content_json?.subject || '',
    location: row.metadata?.location || row.content_json?.location || null, role: row.metadata?.assetRole || row.metadata?.role || null, tags: row.metadata?.tags || row.content_json?.tags || [],
    durationSeconds: row.metadata?.durationSeconds || row.content_json?.durationSeconds || null,
  }));
}
async function persistJsonVersion({ pool, episodeId, kind, baseVersionId, payload, inputVersionIds, actor }) {
  const fingerprint = hash({ kind, baseVersionId, payload, inputVersionIds: [...new Set(inputVersionIds)].sort() });
  const versionId = `${kind}:visual:${fingerprint}`;
  const artifactId = `${kind}-visual-artifact:${fingerprint}`;
  const checksum = contentHash(payload);
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,parent_id,payload,content_hash,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (id) DO NOTHING`, [versionId, episodeId, kind, baseVersionId || null, JSON.stringify(payload), checksum, actor || 'visual-continuity']);
  for (const dependency of [...new Set([baseVersionId, ...inputVersionIds].filter(Boolean))]) await pool.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, versionId, dependency]);
  await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,$3,$4,NULL,$5::jsonb,$6,'application/json','visual-continuity',$7::jsonb,$8::jsonb,$9) ON CONFLICT (id) DO NOTHING`, [artifactId, episodeId, kind, versionId, JSON.stringify(payload), checksum, JSON.stringify(inputVersionIds), JSON.stringify({ visualRecipe: true, recipeVersion: visual.RECIPE_VERSION, baseVersionId, immutable: true }), actor || 'visual-continuity']);
  return { versionId, artifactId, checksum };
}

function install() {
  const target = require.resolve('../pipeline/http-workflow-handlers');
  const mod = require(target);
  if (mod.__visualContinuityInstalled) return;
  const originalFactory = mod.createHttpWorkflowHandlers;
  mod.createHttpWorkflowHandlers = function visualAwareFactory(options) {
    const handlers = originalFactory(options);
    const pool = options.pool;
    const originalScenePlan = handlers['workflow:scene_plan'];
    const originalAssets = handlers['workflow:assets'];
    const originalTimeline = handlers['workflow:timeline'];
    handlers['workflow:scene_plan'] = async (payload, job) => {
      const result = await originalScenePlan(payload, job);
      const row = await pool.query('SELECT id,kind,payload FROM version_records WHERE id=$1 AND episode_id=$2', [result.versionId, payload.episodeId]);
      if (!row.rows[0]) throw Object.assign(new Error('Scene-plan provider output disappeared before visual planning'), { code: 'VISUAL_PLAN_INPUT_MISSING', retryable: false });
      const assets = await loadAssets(pool, payload.episodeId);
      const recipe = visual.buildVisualRecipe({ episodeId: payload.episodeId, scenePlanVersionId: result.versionId, plan: payloadFromVersion(row.rows[0]), assets, narrationVersionIds: payload.inputVersionIds || [] });
      const enriched = { ...payloadFromVersion(row.rows[0]), visualRecipe: recipe };
      const derived = await persistJsonVersion({ pool, episodeId: payload.episodeId, kind: 'scene-plan', baseVersionId: result.versionId, payload: enriched, inputVersionIds: payload.inputVersionIds || [], actor: payload.actor });
      return { ...result, versionId: derived.versionId, artifactId: derived.artifactId, visualRecipe: recipe, visualRecipeFingerprint: recipe.recipeFingerprint, derivedFromVersionId: result.versionId };
    };
    handlers['workflow:assets'] = async (payload, job) => {
      const scenePlan = await loadScenePlan(pool, payload.episodeId, payload.inputVersionIds || []);
      const assets = await loadAssets(pool, payload.episodeId);
      const recipe = scenePlan?.payload?.visualRecipe || null;
      const visualRequirements = recipe ? { recipeVersion: recipe.recipeVersion, recipeFingerprint: recipe.recipeFingerprint, broll: recipe.broll, continuity: recipe.continuity, assets: assets.map((asset) => ({ id: asset.id, versionId: asset.versionId, metadata: asset.metadata, contentHash: asset.contentHash })) } : null;
      return originalAssets({ ...payload, visualRequirements }, job);
    };
    handlers['workflow:timeline'] = async (payload, job) => {
      const scenePlan = await loadScenePlan(pool, payload.episodeId, payload.inputVersionIds || []);
      const assets = await loadAssets(pool, payload.episodeId);
      const recipe = scenePlan?.payload?.visualRecipe || null;
      const enrichedPayload = recipe ? { ...payload, visualRecipe: recipe, visualAssets: assets.map((asset) => ({ id: asset.id, versionId: asset.versionId, contentHash: asset.contentHash, metadata: asset.metadata, mediaType: asset.mediaType })) } : payload;
      const result = await originalTimeline(enrichedPayload, job);
      if (!recipe || !result.versionId) return result;
      const timelineRow = await pool.query('SELECT id,kind,payload FROM version_records WHERE id=$1 AND episode_id=$2', [result.versionId, payload.episodeId]);
      if (!timelineRow.rows[0]) return result;
      const timeline = timelineRow.rows[0].payload?.timeline || timelineRow.rows[0].payload;
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      for (const asset of assets) assetById.set(asset.versionId, asset);
      const applied = visual.applyRecipeToTimeline(timeline, recipe, assetById);
      const inputVersionIds = [...new Set([...(timeline.inputVersionIds || []), ...(payload.inputVersionIds || []), ...recipe.deterministicInputs.assetIds, scenePlan.id])];
      const derived = await persistJsonVersion({ pool, episodeId: payload.episodeId, kind: 'timeline', baseVersionId: result.versionId, payload: applied, inputVersionIds, actor: payload.actor });
      return { ...result, versionId: derived.versionId, artifactId: derived.artifactId, visualRecipeFingerprint: recipe.recipeFingerprint, derivedFromVersionId: result.versionId };
    };
    return handlers;
  };
  mod.__visualContinuityInstalled = true;
}

install();
module.exports = { install };
