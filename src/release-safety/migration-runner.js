const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrationPreflight } = require('./release-safety');

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function hasTopLevelTransaction(sql) {
  const withoutLeadingComments = sql.replace(/^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*/, '');
  return /^BEGIN\s*;[\s\S]*\n\s*COMMIT\s*;?\s*$/i.test(withoutLeadingComments);
}

async function ensureMigrationLock(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS forge_migration_lock(
    id boolean PRIMARY KEY DEFAULT true CHECK(id),
    release_id text,
    owner text,
    acquired_at timestamptz,
    expires_at timestamptz,
    state text NOT NULL DEFAULT 'FREE' CHECK(state IN('FREE','HELD','DRAINING'))
  )`);
  await pool.query("INSERT INTO forge_migration_lock(id) VALUES(true) ON CONFLICT(id) DO NOTHING");
}

async function runSafeMigrations({ pool, migrationsDir = path.join(__dirname, '..', '..', 'migrations'), actor = 'migration-runner' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');

  await pool.query(`CREATE TABLE IF NOT EXISTS forge_schema_migrations(
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE forge_schema_migrations ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT 'migration-runner'`);
  await pool.query(`ALTER TABLE forge_schema_migrations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'APPLIED'`);
  await ensureMigrationLock(pool);

  const preflight = await migrationPreflight({ pool, migrationsDir });
  if (!preflight.ok) {
    throw Object.assign(new Error(`Migration preflight failed: ${JSON.stringify({
      checksumMismatches: preflight.checksumMismatches,
      unsafePending: preflight.unsafePending,
      duplicatePendingNumbers: preflight.duplicatePendingNumbers,
    })}`), { code: 'MIGRATION_PREFLIGHT_FAILED', evidence: preflight });
  }

  const activeJobs = Number((await pool.query("SELECT count(*)::int AS count FROM forge_jobs WHERE status='RUNNING'")).rows[0]?.count || 0);
  if (activeJobs && preflight.unsafePending.length) {
    throw Object.assign(new Error(`Unsafe pending migrations cannot run with ${activeJobs} active jobs`), {
      code: 'MIGRATION_ACTIVE_WORKLOAD',
      evidence: { activeJobs, unsafePending: preflight.unsafePending },
    });
  }

  const client = await pool.connect();
  const applied = [];
  let advisoryLockHeld = false;
  try {
    // Keep the session-level advisory lock for the entire migration apply.
    // The previous transaction-scoped lock was released before migration SQL
    // ran, allowing concurrent runners to observe HELD and fail spuriously.
    await client.query("SELECT pg_advisory_lock(hashtext('forge-migration-apply'))");
    advisoryLockHeld = true;

    await client.query('SELECT state FROM forge_migration_lock WHERE id=true FOR UPDATE');
    await client.query(
      "UPDATE forge_migration_lock SET owner=$1,acquired_at=now(),expires_at=now()+interval '30 minutes',state='HELD' WHERE id=true",
      [actor],
    );

    for (const migration of preflight.pending) {
      const raw = await fs.readFile(path.join(migrationsDir, migration.name), 'utf8');
      try {
        const current = await client.query('SELECT checksum,status FROM forge_schema_migrations WHERE version=$1 FOR UPDATE', [migration.name]);
        if (current.rows[0]?.checksum && current.rows[0].checksum !== checksum(raw)) {
          throw new Error(`Applied migration checksum differs from file: ${migration.name}`);
        }
        if (current.rows[0]?.status === 'APPLIED') continue;

        if (hasTopLevelTransaction(raw)) {
          await client.query(raw);
        } else {
          await client.query('BEGIN');
          try {
            await client.query(raw);
            await client.query('COMMIT');
          } catch (error) {
            try { await client.query('ROLLBACK'); } catch {}
            throw error;
          }
        }

        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO forge_schema_migrations(version,checksum,applied_by,status)
             VALUES($1,$2,$3,'APPLIED')
             ON CONFLICT(version) DO UPDATE SET
               checksum=EXCLUDED.checksum,
               applied_by=EXCLUDED.applied_by,
               status='APPLIED',
               applied_at=now()`,
            [migration.name, migration.checksum, actor],
          );
          await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch {}
          throw error;
        }
        applied.push(migration.name);
      } catch (error) {
        throw Object.assign(new Error(`Migration ${migration.name} failed: ${error.message}`), {
          code: 'MIGRATION_FAILED',
          migration: migration.name,
          cause: error,
        });
      }
    }
  } finally {
    if (advisoryLockHeld) {
      try {
        await client.query(
          "UPDATE forge_migration_lock SET owner=NULL,acquired_at=NULL,expires_at=NULL,state='FREE' WHERE id=true AND owner=$1",
          [actor],
        );
      } catch {}
      try { await client.query("SELECT pg_advisory_unlock(hashtext('forge-migration-apply'))"); } catch {}
    }
    client.release();
  }

  return { status: 'ok', applied, current: preflight.audit.current };
}

module.exports = { runSafeMigrations, hasTopLevelTransaction };
