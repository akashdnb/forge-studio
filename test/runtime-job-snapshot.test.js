const test = require('node:test');
const assert = require('node:assert/strict');
const { assertJobRuntimeSnapshot } = require('../src/runtime/job-runtime-snapshot');

test('job admission freezes a snapshot and honors emergency kill switch', async () => {
  const rows = new Map();
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT runtime_snapshot')) return { rows: rows.has(params[0]) ? [{ runtime_snapshot: rows.get(params[0]) }] : [] };
      if (sql.startsWith('UPDATE forge_jobs')) { rows.set(params[3], JSON.parse(params[0])); return { rows: [{ runtime_snapshot: JSON.parse(params[0]) }] }; }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  let kill = false;
  const policyStore = {
    async snapshotForJob() { return { config: { execution: { enabled: true } }, policyVersions: ['TENANT:t1:default:1'], featureFlags: { x: { enabled: !kill, killSwitch: kill, version: kill ? 2 : 1 } }, fingerprint: 'frozen' }; }
  };
  const job = { id: 'job-1', project_id: 'p1', tenant_id: 't1', payload: { provider: 'openai' } };
  const first = await assertJobRuntimeSnapshot({ pool, policyStore, job, actorId: 'w1' });
  assert.equal(first.snapshot.fingerprint, 'frozen');
  kill = true;
  await assert.rejects(() => assertJobRuntimeSnapshot({ pool, policyStore, job, actorId: 'w1' }), /disabled by kill switch/);
});
