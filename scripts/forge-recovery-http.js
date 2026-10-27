#!/usr/bin/env node
const http = require('node:http');
const { Pool } = require('pg');
const { BackupService } = require('../src/recovery/backup-service');
const { createStorageFromEnv } = require('../src/storage');
const { installRecoveryRoutes } = require('../src/recovery/recovery-http');

const port = Number(process.env.FORGE_RECOVERY_PORT || 9090);
const token = process.env.FORGE_RECOVERY_HEALTH_TOKEN;
if (!token) throw new Error('FORGE_RECOVERY_HEALTH_TOKEN is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
const service = new BackupService({ pool, storage: createStorageFromEnv() });
const server = http.createServer();
installRecoveryRoutes(server, { service, pool, authorize: async (request) => request.headers.authorization === `Bearer ${token}` });
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(JSON.stringify({ status: 'started', port })));
const shutdown = async () => { server.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
