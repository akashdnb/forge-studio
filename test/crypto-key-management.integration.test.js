const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { KeyManagementService } = require('../src/crypto/key-management');

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
let pool;

async function migrate() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await pool.query(await fs.readFile(path.join(__dirname, '..', 'migrations', '114_cryptographic_key_management.sql'), 'utf8'));
}

async function cleanup(tenant) {
  await pool.query('DELETE FROM forge_crypto_reencryption_jobs WHERE tenant_id=$1', [tenant]);
  await pool.query('DELETE FROM forge_crypto_key_audit WHERE tenant_id=$1', [tenant]);
  await pool.query('DELETE FROM forge_crypto_key_epochs WHERE tenant_id=$1', [tenant]);
}

test('crypto migration is ordered after the current migration set', async () => {
  const names = (await fs.readdir(path.join(__dirname, '..', 'migrations'))).filter((name) => /^\d+_.*\.sql$/.test(name));
  const numbers = names.map((name) => Number(name.split('_', 1)[0]));
  assert.equal(numbers.filter((n) => n === 114).length, 1);
  assert.ok(Math.max(...numbers.filter((n) => n < 114)) < 114);
});

test('PostgreSQL key epochs isolate tenants, rotate without rewriting history, and reject revoked ciphertext', { skip }, async () => {
  await migrate();
  const rootKey = Buffer.alloc(32, 7).toString('base64');
  const kms = new KeyManagementService({ pool, rootKey });
  const tenantA = `crypto-a-${Date.now()}`;
  const tenantB = `crypto-b-${Date.now()}`;
  const scope = { purpose: 'runtime-secret' };
  try {
    const first = await kms.encrypt({ tenantId: tenantA, ...scope, plaintext: 'alpha' });
    assert.equal(await kms.decrypt(first), 'alpha');
    await assert.rejects(() => kms.decrypt({ ...first, tenantId: tenantB }), /CIPHERTEXT_INVALID|KEY_EPOCH_UNAVAILABLE|KEY_EPOCH_REVOKED/);

    const rotated = await kms.rotate({ tenantId: tenantA, ...scope, actor: 'test', expectedEpoch: first.epoch });
    assert.equal(Number(rotated.epoch), Number(first.epoch) + 1);
    const second = await kms.encrypt({ tenantId: tenantA, ...scope, plaintext: 'bravo' });
    assert.equal(Number(second.epoch), Number(rotated.epoch));
    assert.equal(await kms.decrypt(first), 'alpha');
    assert.equal(await kms.decrypt(second), 'bravo');

    await kms.revoke({ tenantId: tenantA, ...scope, epoch: first.epoch, actor: 'test', reason: 'failure injection' });
    await assert.rejects(() => kms.decrypt(first), /KEY_EPOCH_REVOKED/);
    assert.equal(await kms.decrypt(second), 'bravo');
  } finally {
    await cleanup(tenantA);
    await cleanup(tenantB);
    await pool.end();
    pool = null;
  }
});

test('PostgreSQL concurrent epoch creation converges on one active epoch', { skip }, async () => {
  await migrate();
  const rootKey = Buffer.alloc(32, 9).toString('base64');
  const kms = new KeyManagementService({ pool, rootKey });
  const tenant = `crypto-concurrency-${Date.now()}`;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => kms.ensureEpoch({ tenantId: tenant, projectId: 'p1', purpose: 'provider-credential', actor: 'test' })));
    assert.equal(new Set(results.map((row) => Number(row.epoch))).size, 1);
    const active = await pool.query(`SELECT count(*)::int AS count FROM forge_crypto_key_epochs WHERE tenant_id=$1 AND project_id='p1' AND purpose='provider-credential' AND status='ACTIVE'`, [tenant]);
    assert.equal(active.rows[0].count, 1);
  } finally {
    await cleanup(tenant);
    await pool.end();
    pool = null;
  }
});
