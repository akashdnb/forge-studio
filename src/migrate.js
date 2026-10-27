const { Pool } = require('pg');
const { PersistentProductionRepository } = require('./persistence/production-repository');
const { installPostgresHotpathHardening } = require('./persistence/postgres-hotpath-hardening');

installPostgresHotpathHardening();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  try {
    const repository = new PersistentProductionRepository({ pool });
    const result = await repository.migrate();
    console.log(JSON.stringify({ status: 'ok', ...result }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Forge migration failed:', error.message);
  process.exitCode = 1;
});
