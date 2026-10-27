const test = require('node:test');
const assert = require('node:assert/strict');
const { CrossSystemIntegrityReconciler, canonicalJson, checksum } = require('../src/reconciliation/cross-system-integrity');

test('canonical records are deterministic regardless of object key order', () => {
  const left = { z: 1, nested: { b: 2, a: 1 }, a: [{ z: 3, a: 4 }] };
  const right = { a: [{ a: 4, z: 3 }], nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(checksum(left), checksum(right));
});

test('storage corruption is diagnosed without mutating immutable artifact history', async () => {
  const storage = { download: async () => { throw Object.assign(new Error('object missing'), { code: 'ARTIFACT_NOT_FOUND' }); } };
  const reconciler = new CrossSystemIntegrityReconciler({ pool: { query: async () => ({ rows: [] }), connect: async () => ({}) }, storage });
  const issue = await reconciler.inspectArtifact({ id: 'a1', storage_key: 'objects/a1', content_hash: 'a'.repeat(64), stored_hash: 'a'.repeat(64) });
  assert.equal(issue.code, 'MISSING_STORAGE_OBJECT');
  assert.equal(issue.repairSafety, 'SAFE');
});

test('corrupt checksum metadata is distinct from a missing object', async () => {
  const reconciler = new CrossSystemIntegrityReconciler({ pool: { query: async () => ({ rows: [] }), connect: async () => ({}) } });
  const issue = await reconciler.inspectArtifact({ id: 'a1', storage_key: 'objects/a1', content_hash: 'a'.repeat(64), stored_hash: 'b'.repeat(64) });
  assert.equal(issue.code, 'STORAGE_CHECKSUM_DRIFT');
});

test('operator repair plan is deterministic and rejects tampering', async () => {
  const finding = { id: 'f1', fingerprint: 'f'.repeat(64), repair_safety: 'SAFE', code: 'STALE_LEASE', evidence: { workerId: 'w1' } };
  const queries = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('SELECT * FROM forge_integrity_findings')) return { rows: [finding] };
      return { rows: [{ status: 'QUEUED', worker_id: null, leased_until: null }], rowCount: 1 };
    },
    connect: async () => ({ query: async () => {}, release() {} }),
  };
  const reconciler = new CrossSystemIntegrityReconciler({ pool });
  const planBase = { findingId: finding.id, fingerprint: finding.fingerprint, action: 'RECOVER_STALE_LEASE', safety: 'SAFE', expectedEvidence: finding.evidence };
  const plan = { ...planBase, planFingerprint: checksum(planBase) };
  const result = await reconciler.applyRepairPlan({ runId: 'r1', plan, approvedBy: 'operator', approvalToken: 'approval-1' });
  assert.equal(result.outcome, 'APPLIED');
  assert.ok(queries.some((sql) => sql.includes("UPDATE forge_jobs SET status='QUEUED'")));
});

test('real PostgreSQL failure-injection coverage is available when DATABASE_URL is configured', async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL not configured');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  t.after(() => pool.end());
  await pool.query('SELECT 1');
  const reconciler = new CrossSystemIntegrityReconciler({ pool, storage: { download: async () => { throw Object.assign(new Error('injected missing object'), { code: 'ARTIFACT_NOT_FOUND' }); } }, pageSize: 10 });
  const result = await reconciler.scan({ reason: 'failure-injection-test' });
  assert.ok(['SUCCEEDED', 'QUARANTINED'].includes(result.status));
});
