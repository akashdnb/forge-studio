const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiff, canonical, sha, persistDiff } = require('../src/diff/version-diff');

function makePool({ versions, episode = { id: 'e1', project_id: 'p1', state: 'DRAFT', current_versions: {}, current_render_id: null, approved_render_id: null, published_record_id: null, metadata: {} }, artifacts = [], qa = [], approvals = [], providers = [], costs = [], publishes = [], audits = [] } = {}) {
  const byId = new Map(versions.map((v) => [v.id, v]));
  return {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT id,project_id,state')) return { rows: [episode] };
      if (sql.startsWith('SELECT id,episode_id,kind')) return { rows: versions.filter((v) => params[0].includes(v.id) && v.episode_id === params[1]) };
      if (sql.includes('SELECT * FROM version_records WHERE id=$1')) return { rows: byId.has(params[0]) ? [byId.get(params[0])] : [] };
      if (sql.includes('FROM version_records v JOIN version_dependencies')) return { rows: [] };
      if (sql.includes('FROM version_records v JOIN version_records child')) return { rows: [] };
      if (sql.startsWith('SELECT id,kind,version_id')) return { rows: artifacts };
      if (sql.startsWith('SELECT id,artifact_id,version_id')) return { rows: qa };
      if (sql.startsWith('SELECT id,stage,target_id')) return { rows: approvals };
      if (sql.startsWith('SELECT id,capability')) return { rows: providers };
      if (sql.startsWith('SELECT id,provider_run_id')) return { rows: costs };
      if (sql.startsWith('SELECT id,render_artifact_id')) return { rows: publishes };
      if (sql.startsWith('SELECT id,action,target_type')) return { rows: audits };
      return { rows: [] };
    }
  };
}

test('canonical ordering and identity are stable', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.equal(sha({ b: 2, a: 1 }), sha({ a: 1, b: 2 }));
});

test('version diff is deterministic and captures semantic script changes', async () => {
  const versions = [
    { id: 'v1', episode_id: 'e1', kind: 'script', parent_id: null, payload: { title: 'Old', scenes: [{ id: 's1', narration: 'hello' }] }, content_hash: 'a'.repeat(64), created_by: 'u', created_at: '2026-01-01T00:00:00Z' },
    { id: 'v2', episode_id: 'e1', kind: 'script', parent_id: 'v1', payload: { title: 'New', scenes: [{ id: 's1', narration: 'hello world' }] }, content_hash: 'b'.repeat(64), created_by: 'u', created_at: '2026-01-02T00:00:00Z' }
  ];
  const pool = makePool({ versions });
  const a = await buildDiff({ pool, episodeId: 'e1', sourceVersionId: 'v1', targetVersionId: 'v2' });
  const b = await buildDiff({ pool, episodeId: 'e1', sourceVersionId: 'v1', targetVersionId: 'v2' });
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, 'forge-version-diff-v1');
  assert.ok(a.items.some((x) => x.category === 'script' && x.path.includes('narration')));
  assert.equal(a.reportHash.length, 64);
});

test('missing evidence is represented by the immutable snapshot rather than mutating source versions', async () => {
  const versions = [
    { id: 'v1', episode_id: 'e1', kind: 'render', parent_id: null, payload: { artifactId: 'missing-artifact' }, content_hash: 'c'.repeat(64), created_by: 'u', created_at: '2026-01-01T00:00:00Z' },
    { id: 'v2', episode_id: 'e1', kind: 'render', parent_id: 'v1', payload: { artifactId: 'missing-artifact' }, content_hash: 'd'.repeat(64), created_by: 'u', created_at: '2026-01-02T00:00:00Z' }
  ];
  const before = JSON.stringify(versions);
  const report = await buildDiff({ pool: makePool({ versions }), episodeId: 'e1', sourceVersionId: 'v1', targetVersionId: 'v2' });
  assert.equal(JSON.stringify(versions), before);
  assert.equal(report.sourceVersionId, 'v1');
  assert.equal(report.targetVersionId, 'v2');
});

test('persistDiff is idempotent for the same immutable identity', async () => {
  const rows = new Map();
  const inserted = [];
  const pool = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM forge_version_diffs WHERE report_identity=$1')) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
      if (sql.includes('INSERT INTO forge_version_diffs')) {
        const row = { report_id: params[0], report_identity: params[0], status: 'COMPLETED' };
        rows.set(params[0], row); inserted.push(row); return { rows: [row] };
      }
      if (sql.includes('INSERT INTO forge_version_diff_items')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_events')) return { rows: [] };
      if (sql.includes('SELECT * FROM forge_version_diffs WHERE report_id=$1')) return { rows: [rows.get(params[0])] };
      throw new Error(`Unhandled SQL: ${sql}`);
    }
  };
  const report = { reportIdentity: 'a'.repeat(64), reportHash: 'b'.repeat(64), snapshotHash: 'c'.repeat(64), episodeId: 'e1', projectId: 'p1', sourceVersionId: 'v1', targetVersionId: 'v2', schemaVersion: 'forge-version-diff-v1', summary: { total: 0 }, items: [] };
  await persistDiff(pool, report, 'u');
  await persistDiff(pool, report, 'u');
  assert.equal(inserted.length, 1);
});
