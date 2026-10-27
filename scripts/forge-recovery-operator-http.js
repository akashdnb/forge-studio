#!/usr/bin/env node
const http = require('node:http');
const { Pool } = require('pg');
const { BackupService } = require('../src/recovery/backup-service');
const { RecoveryControlPlane } = require('../src/recovery/recovery-control');
const { createStorageFromEnv } = require('../src/storage');
const { installRecoveryRoutes } = require('../src/recovery/recovery-http');
const { installRecoveryOperatorRoutes } = require('../src/recovery/recovery-operator-http');

const port = Number(process.env.FORGE_RECOVERY_PORT || 9090);
const authSecret = process.env.FORGE_AUTH_SIGNING_SECRET;
if (!authSecret && !process.env.API_BEARER_TOKEN) throw new Error('FORGE_AUTH_SIGNING_SECRET or API_BEARER_TOKEN is required');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
const backup = new BackupService({ pool, storage: createStorageFromEnv() });
const control = new RecoveryControlPlane({ pool, backupService: backup, maxConcurrency: Number(process.env.FORGE_RECOVERY_MAX_CONCURRENCY || 1) });
const server = http.createServer();
installRecoveryOperatorRoutes(server, { control, authSecret, apiToken: process.env.API_BEARER_TOKEN, staticActor: process.env.FORGE_STATIC_ACTOR_ID, staticTenant: process.env.FORGE_STATIC_TENANT_ID });
installRecoveryRoutes(server, { service: backup, pool, authorize: async (request) => Boolean(request.headers.authorization) });
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(JSON.stringify({ status: 'started', port, operatorOnly: true })));
const shutdown = async () => { server.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
