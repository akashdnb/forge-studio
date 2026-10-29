const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });
  try {
    const identity = await pool.query("SELECT current_database() AS database_name, current_schema() AS schema_name, current_user AS database_user");
    console.log(`Tenant schema bootstrap connected to database=${identity.rows[0].database_name} schema=${identity.rows[0].schema_name} user=${identity.rows[0].database_user}`);
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
    const verify = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name='tenant_id') AS tenant_column_exists");
    console.log(`Tenant schema bootstrap verified tenant_id=${verify.rows[0].tenant_column_exists}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Tenant schema bootstrap failed: ${error.message}`);
  process.exit(1);
});
