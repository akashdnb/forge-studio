const { Pool } = require('pg');
const { ImmutableUsageLedger } = require('../src/usage/immutable-usage-ledger');
const { createUsageOperatorServer } = require('../src/usage/operator-api');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const port = Number.parseInt(process.env.FORGE_USAGE_OPERATOR_PORT || '8091', 10);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_DB_POOL_MAX || '10', 10) });
const ledger = new ImmutableUsageLedger({ pool });
const server = createUsageOperatorServer({ ledger });
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Forge usage operator API listening on :${port}`));
function shutdown() { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
