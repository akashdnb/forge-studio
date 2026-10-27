const { Pool } = require('pg');
const { runSafeMigrations } = require('./release-safety/migration-runner');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = await runSafeMigrations({ pool, actor: process.env.FORGE_RELEASE_ID || 'migration-runner' });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Forge migration failed:', error.message);
  if (error.evidence) console.error(JSON.stringify(error.evidence));
  process.exitCode = 1;
});
