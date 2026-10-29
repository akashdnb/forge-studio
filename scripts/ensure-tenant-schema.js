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

    // Repair tenant-column drift on tables introduced before tenant isolation was
    // added. This is intentionally conditional so fresh databases can still run
    // the canonical migrations that create these tables later.
    const existingTables = await pool.query(`
      SELECT
        to_regclass('public.forge_jobs') IS NOT NULL AS forge_jobs_exists,
        to_regclass('public.project_members') IS NOT NULL AS project_members_exists,
        to_regclass('public.lifecycle_holds') IS NOT NULL AS lifecycle_holds_exists
    `);

    if (existingTables.rows[0].forge_jobs_exists) {
      await pool.query('ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS tenant_id text');
      await pool.query(`
        UPDATE forge_jobs j
        SET tenant_id = p.tenant_id
        FROM projects p
        WHERE j.project_id = p.id
          AND j.tenant_id IS NULL
          AND p.tenant_id IS NOT NULL
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS forge_jobs_tenant_idx ON forge_jobs(tenant_id)');
    }

    if (existingTables.rows[0].project_members_exists) {
      await pool.query('ALTER TABLE project_members ADD COLUMN IF NOT EXISTS tenant_id text');
      await pool.query(`
        UPDATE project_members pm
        SET tenant_id = p.tenant_id
        FROM projects p
        WHERE pm.project_id = p.id
          AND pm.tenant_id IS NULL
          AND p.tenant_id IS NOT NULL
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS project_members_tenant_idx ON project_members(tenant_id)');
    }

    if (existingTables.rows[0].lifecycle_holds_exists) {
      await pool.query('ALTER TABLE lifecycle_holds ADD COLUMN IF NOT EXISTS tenant_id text');
      await pool.query(`
        UPDATE lifecycle_holds h
        SET tenant_id = p.tenant_id
        FROM projects p
        WHERE h.project_id = p.id
          AND h.tenant_id IS NULL
          AND p.tenant_id IS NOT NULL
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS lifecycle_holds_tenant_idx ON lifecycle_holds(tenant_id)');
    }

    const verify = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'tenant_id'
        AND table_name IN ('projects', 'forge_jobs', 'project_members', 'lifecycle_holds')
      ORDER BY table_name
    `);
    console.log(`Tenant schema bootstrap verified tenant_columns=${verify.rows.map((row) => `${row.table_name}.${row.column_name}`).join(',') || 'none'}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Tenant schema bootstrap failed: ${error.message}`);
  process.exit(1);
});
