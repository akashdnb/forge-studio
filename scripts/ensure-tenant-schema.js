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
    const table = await pool.query("SELECT to_regclass('public.projects') AS name");
    if (!table.rows[0]?.name) return;
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
