const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerationRecipeService, canonicalJson, redact, sha256, assertCompatibility, SCHEMA_VERSION } = require('../src/generation-reproducibility/service');

test('canonical serialization is stable and secrets/PII are redacted', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  const safe = redact({ apiKey: 'secret', email: 'person@example.com', prompt: 'hello person@example.com' });
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.email, '[REDACTED]');
  assert.match(safe.prompt, /REDACTED_EMAIL/);
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }));
});

test('compatibility fails closed on provider/model/contract drift and retirement', () => {
  const recipe = { schemaVersion: SCHEMA_VERSION, lifecycleStatus: 'ACTIVE', snapshot: { provider: { name: 'p1' }, model: { id: 'm1' }, providerContract: { version: 'v1' } } };
  assert.throws(() => assertCompatibility(recipe, { provider: 'p2' }), /Provider drift/);
  assert.throws(() => assertCompatibility(recipe, { model: 'm2' }), /Model drift/);
  assert.throws(() => assertCompatibility(recipe, { providerContractVersion: 'v2' }), /contract version drift/);
  process.env.FORGE_RETIRED_PROVIDERS = 'p1';
  assert.throws(() => assertCompatibility(recipe), /retired/);
  delete process.env.FORGE_RETIRED_PROVIDERS;
});

const integration = Boolean(process.env.DATABASE_URL);
test('postgres concurrency, immutable snapshots, replay dependency and lifecycle regression', { skip: !integration }, async () => {
  const { Pool } = require('pg');
  const { PostgresRepository } = require('../src/persistence/postgres-repository');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    await new PostgresRepository({ pool }).migrate();
    const project = (await pool.query('SELECT id,tenant_id,created_by FROM projects ORDER BY created_at LIMIT 1')).rows[0];
    if (!project) return;
    const service = new GenerationRecipeService({ pool });
    const base = { tenantId: project.tenant_id, projectId: project.id, recipeKey: `test-repro:${Date.now()}`, capability: 'text-generation', prompt: 'safe replay test', model: { id: 'test-model' }, provider: { name: 'test-provider' }, providerContract: { version: 'test-v1' }, actor: project.created_by || 'test' };
    const [a, b] = await Promise.all([service.createSnapshot(base), service.createSnapshot(base)]);
    assert.deepEqual([a.version, b.version].sort((x, y) => x - y), [1, 2]);
    await assert.rejects(() => service.createSnapshot({ ...base, expectedVersion: 0 }), /revision conflict/);
    const withMissingInput = await service.createSnapshot({ ...base, recipeKey: `${base.recipeKey}:missing`, inputArtifactDigests: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] });
    await assert.rejects(() => service.resolve(withMissingInput.id, { tenantId: project.tenant_id, projectId: project.id, forReplay: true }), /missing input artifact dependencies/);
    await pool.query('UPDATE generation_recipe_lifecycle SET status=\'DEPRECATED\' WHERE recipe_id=$1', [a.id]);
    await assert.rejects(() => service.replay(a.id, { tenantId: project.tenant_id, projectId: project.id, actor: project.created_by || 'test' }), /deprecated/);
    const lifecycle = await service.lifecycle(a.id, { tenantId: project.tenant_id, projectId: project.id, status: 'ACTIVE', actor: project.created_by || 'test' });
    assert.equal(lifecycle.status, 'ACTIVE');
    await pool.query('DELETE FROM generation_recipe_inputs WHERE recipe_id=$1', [withMissingInput.id]);
    const resolved = await service.resolve(a.id, { tenantId: project.tenant_id, projectId: project.id });
    assert.equal(resolved.schemaVersion, SCHEMA_VERSION);
    await assert.rejects(() => pool.query('UPDATE generation_recipes SET prompt_hash=prompt_hash WHERE id=$1', [a.id]), /immutable/);
  } finally { await pool.end(); }
});
