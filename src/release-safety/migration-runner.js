const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrationPreflight, normalizeSql } = require('./release-safety');

function checksum(sql) { return crypto.createHash('sha256').update(sql).digest('hex'); }

async function runSafeMigrations({ pool, migrationsDir = path.join(__dirname, '..', '..', 'migrations'), actor = 'migration-runner' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
  await pool.query(`CREATE TABLE IF NOT EXISTS forge_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text NOT NULL DEFAULT 'migration-runner', status text NOT NULL DEFAULT 'APPLIED' CHECK(status IN ('APPLIED','FAILED')))`).catch(async (e) => {
    if (e.code !== '42701') throw e;
    await pool.query(`ALTER TABLE forge_schema_migrations ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT 'migration-runner'; ALTER TABLE forge_schema_migrations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'APPLIED'`);
  });
  const preflight = await migrationPreflight({ pool, migrationsDir });
  if (!preflight.ok) throw Object.assign(new Error(`Migration preflight failed: ${JSON.stringify({ checksumMismatches: preflight.checksumMismatches, unsafePending: preflight.unsafePending, duplicatePendingNumbers: preflight.duplicatePendingNumbers })}`), { code: 'MIGRATION_PREFLIGHT_FAILED', evidence: preflight });
  const applied = [];
  for (const migration of preflight.pending) {
    const sql = normalizeSql(await fs.readFile(path.join(migrationsDir, migration.name), 'utf8'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['forge-migration-apply']);
      const current = await client.query('SELECT checksum,status FROM forge_schema_migrations WHERE version=$1 FOR UPDATE', [migration.name]);
      if (current.rows[0]?.checksum && current.rows[0].checksum !== checksum(await fs.readFile(path.join(migrationsDir, migration.name), 'utf8'))) throw new Error(`Applied migration checksum differs from file: ${migration.name}`);
      if (current.rows[0]?.status === 'APPLIED') { await client.query('COMMIT'); continue; }
      await client.query(sql);
      await client.query(`INSERT INTO forge_schema_migrations(version,checksum,applied_by,status) VALUES($1,$2,$3,'APPLIED') ON CONFLICT(version) DO UPDATE SET checksum=EXCLUDED.checksum,applied_by=EXCLUDED.applied_by,status='APPLIED',applied_at=now()`, [migration.name, migration.checksum, actor]);
      await client.query('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw Object.assign(new Error(`Migration ${migration.name} failed: ${error.message}`), { code: 'MIGRATION_FAILED', migration: migration.name, cause: error });
    } finally { client.release(); }
  }
  return { status: 'ok', applied, current: preflight.audit.current };
}

module.exports = { runSafeMigrations };
