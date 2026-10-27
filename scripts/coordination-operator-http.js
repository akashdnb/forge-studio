'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { DistributedLock } = require('../src/coordination/distributed-lock');

const port = Number.parseInt(process.env.COORDINATION_OPERATOR_PORT || '8091', 10);
const token = process.env.FORGE_COORDINATION_OPERATOR_TOKEN || process.env.API_BEARER_TOKEN;
if (!token) throw new Error('FORGE_COORDINATION_OPERATOR_TOKEN or API_BEARER_TOKEN is required');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('COORDINATION_OPERATOR_PORT must be a valid port');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_COORDINATION_OPERATOR_POOL_MAX || '4', 10), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
const coordinator = new DistributedLock({ pool, ownerId: `coordination-operator:${process.pid}` });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const authorized = (req) => (req.headers.authorization || '') === `Bearer ${token}`;
const body = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); if (!chunks.length) return {}; return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return json(res, 401, { error: { code: 'UNAUTHORIZED' } });
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') return json(res, 200, await coordinator.health());
    if (url.pathname === '/locks' && req.method === 'GET') return json(res, 200, { items: await coordinator.inspect({ scopeKey: url.searchParams.get('scopeKey'), tenantId: url.searchParams.get('tenantId'), projectId: url.searchParams.get('projectId'), includeReleased: url.searchParams.get('includeReleased') === 'true', limit: Number(url.searchParams.get('limit') || 100) }) });
    if (url.pathname === '/locks/recover' && req.method === 'POST') { const input = await body(req); return json(res, 200, await coordinator.recoverExpired({ scopeKey: input.scopeKey, reason: input.reason || 'operator_recovery' })); }
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const result = await pool.query(`SELECT event_type, count(*)::int AS count FROM forge_coordination_audit WHERE created_at > clock_timestamp()-interval '1 hour' GROUP BY event_type ORDER BY event_type`);
      const held = await coordinator.health();
      return json(res, 200, { window: '1h', held: held.held, expired: held.expired, events: result.rows });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND' } });
  } catch (error) { return json(res, Number(error.statusCode || 500), { error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }); }
});

server.listen(port, process.env.COORDINATION_OPERATOR_HOST || '127.0.0.1', () => console.log(`Forge coordination operator listening on ${port}`));
const shutdown = async () => { server.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
