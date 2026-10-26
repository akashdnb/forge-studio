const { createApiServer } = require('./http-api');
const { PersistentProductionRepository } = require('./persistence/production-repository');

const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError('PORT must be an integer between 1 and 65535');
}

async function start() {
  let repository = null;
  if (process.env.DATABASE_URL) {
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch {
      throw new Error('DATABASE_URL is set but the optional pg package is unavailable');
    }
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    repository = new PersistentProductionRepository({ pool });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end();
      throw new Error(`PostgreSQL connection failed: ${error.message}`);
    }
    if (process.env.RUN_MIGRATIONS_ON_START === 'true') {
      await repository.migrate();
    }
  }

  const { server } = createApiServer({
    repository,
    apiToken: process.env.API_BEARER_TOKEN || null,
    allowUnauthenticatedRead: process.env.ALLOW_UNAUTHENTICATED_READS === 'true',
  });
  server.listen(port, host, () => {
    console.log(`Forge Studio API listening on ${host}:${port}; persistence=${repository ? 'postgres' : 'in-memory'}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => {
      console.error(`Forced shutdown after ${signal}`);
      process.exit(1);
    }, 10000);
    timeout.unref();
    server.close(async (error) => {
      if (error) {
        console.error(`Failed to close HTTP server after ${signal}`, error.message);
        process.exitCode = 1;
      }
      if (repository) await repository.db.pool.end().catch(() => {});
      clearTimeout(timeout);
      process.exit();
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Forge API startup failed:', error.message);
  process.exitCode = 1;
});
