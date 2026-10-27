if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { Pool } = require('pg');
const { createWorker, loadHandlers } = require('../src/worker');
const { createGenerationHandlers } = require('../src/generation/worker-handlers');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
const handlers = loadHandlers({ pool });
Object.assign(handlers, createGenerationHandlers({ pool }));
const worker = createWorker({ pool, handlers });
const shutdown = async () => { await worker.stop(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
worker.run().catch(async (error) => { console.error('Forge worker failed:', error); await pool.end(); process.exit(1); });