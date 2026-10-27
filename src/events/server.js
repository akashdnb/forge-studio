const { Pool } = require('pg');
const { createDurableEventApi } = require('./http-api');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const port = Number(process.env.FORGE_EVENT_PORT || 8090);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.FORGE_EVENT_API_PG_POOL_MAX || 5), connectionTimeoutMillis: 5000 });
const { server } = createDurableEventApi({ pool });
pool.query('SELECT 1').then(() => server.listen(port, '0.0.0.0', () => console.log(`Forge durable event API listening on 0.0.0.0:${port}`))).catch(async (error) => { console.error(`Forge durable event API startup failed: ${error.message}`); await pool.end(); process.exitCode = 1; });
async function shutdown() { await new Promise((resolve) => server.close(resolve)); await pool.end(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
