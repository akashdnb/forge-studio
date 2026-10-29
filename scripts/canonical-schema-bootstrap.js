const { Pool } = require('pg');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  const files = ['canonical-schema.sql','canonical-schema-1.sql','canonical-schema-2.sql','canonical-schema-3.sql'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      const sql = await readFile(path.join(__dirname, '..', 'src', 'persistence', file), 'utf8');
      await client.query(sql);
    }
    const tenantId = process.env.FORGE_STATIC_TENANT_ID || 'forge-default-tenant';
    const actorId = process.env.FORGE_STATIC_ACTOR_ID || 'system';
    await client.query(
      'INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [tenantId, `Forge tenant ${tenantId}`, actorId],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ status: 'ok', schema: 'canonical-fresh', files }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Canonical schema bootstrap failed: ${error.message}`);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => { process.exitCode = 1; });
