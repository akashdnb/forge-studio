const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EpisodeBundleService, redact, canonical, sha256 } = require('../src/recovery/episode-bundle-service');
const { createReplayHandler } = require('../src/recovery/replay-worker');
const execFileAsync = promisify(execFile);

test('bundle redaction removes secret-shaped keys and signed URL material', () => {
  const value = redact({ apiKey: 'do-not-export', nested: { password: 'nope', safe: 'ok' }, url: 'https://example.test/a?X-Amz-Signature=secret' });
  assert.equal(value.apiKey, undefined);
  assert.equal(value.nested.password, undefined);
  assert.equal(value.nested.safe, 'ok');
  assert.equal(value.url, 'https://example.test/a');
});

test('canonical serialization is deterministic', () => {
  assert.equal(canonical({ b: 2, a: { d: 4, c: 3 } }), canonical({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(sha256(Buffer.from('forge')), sha256(Buffer.from('forge')));
});

test('bundle archive validation rejects checksum corruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bundle-test-'));
  const dir = path.join(root, 'bundle'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'forge-episode-bundle', schemaVersion: 1, bundleId: 'test-bundle' }));
  await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({ records: { projects: [{ id: 'p1' }] } }));
  await fs.writeFile(path.join(dir, 'artifacts.json'), '[]');
  await fs.writeFile(path.join(dir, 'checksums.json'), JSON.stringify({ 'manifest.json': 'bad', 'snapshot.json': sha256(await fs.readFile(path.join(dir, 'snapshot.json'))), 'artifacts.json': sha256(Buffer.from('[]')) }));
  const archive = path.join(root, 'bad.tar.gz'); await execFileAsync('tar', ['-czf', archive, '-C', dir, 'manifest.json', 'snapshot.json', 'artifacts.json', 'checksums.json']);
  const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('not used'); } };
  const service = new EpisodeBundleService({ pool });
  await assert.rejects(() => service.validateArchive(archive), (error) => error.code === 'BUNDLE_CHECKSUM_MISMATCH');
  await fs.rm(root, { recursive: true, force: true });
});

test('replay handler produces deterministic side-effect-free result', async () => {
  const replay = { id: 'r1', stage_kind: 'workflow:timeline', input_digest: sha256(canonical({ fixtureVersion: 1 })) };
  const client = {
    async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes('SELECT * FROM forge_replay_runs')) return { rows: [replay] };
      if (sql.includes('UPDATE forge_replay_runs')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {}
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const handler = createReplayHandler({ pool });
  const result = await handler({ replayRunId: 'r1', fixture: { fixtureVersion: 1 }, sideEffectsSuppressed: true });
  assert.equal(result.replay.sideEffectsSuppressed, true);
  assert.equal(result.replay.deterministicResult, sha256('workflow:timeline:' + replay.input_digest));
  assert.equal(result.usageAccounting.actualCost, 0);
});
