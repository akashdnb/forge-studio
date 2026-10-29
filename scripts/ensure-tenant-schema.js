const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) return;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id text PRIMARY KEY,
        name text NOT NULL,
        created_by text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        tenant_id text
      )
    `);
    await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text');
    await pool.query('CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC)');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Tenant schema bootstrap failed: ${error.message}`);
  process.exit(1);
});
