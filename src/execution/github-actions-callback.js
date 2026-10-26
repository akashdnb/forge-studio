const { timingSafeEqual } = require('node:crypto');
const { createGithubActionsExecutionBackend } = require('./github-actions-backend');
const JSON_LIMIT_BYTES = 256 * 1024;
function tokenMatches(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a = Buffer.from(expected); const b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
async function readJson(req) { let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > JSON_LIMIT_BYTES) throw Object.assign(new Error('Callback body exceeds 256 KiB'), { statusCode: 413 }); chunks.push(chunk); } try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('Malformed callback JSON'), { statusCode: 400 }); } }
function json(res, status, body) { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function handleGithubRunnerCallback(req, res, { pool, token = process.env.FORGE_RUNNER_CALLBACK_TOKEN, logger = console } = {}) {
  if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  if (!tokenMatches(token, req.headers['x-forge-runner-token'])) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid runner callback token' } });
  try {
    const body = await readJson(req); const required = ['jobId', 'correlationId', 'status']; for (const field of required) if (typeof body[field] !== 'string' || !body[field]) throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
    const backend = createGithubActionsExecutionBackend({ pool, queue: { get: async (id) => (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [id])).rows[0] || null }, config: { mode: 'local', ref: 'callback', timeoutMs: 1800000, dispatchGraceMs: 60000, maxDispatchesPerTick: 0 }, client: { cancel: async () => true }, logger });
    const result = await backend.applyCallback({ jobId: body.jobId, correlationId: body.correlationId, status: body.status, githubRunId: body.githubRunId || null, githubRunAttempt: body.githubRunAttempt || null, metadata: body.metadata || {} });
    return json(res, 200, { item: result });
  } catch (error) { return json(res, error.statusCode || (error.code === 'NOT_FOUND' ? 404 : 422), { error: { code: error.code || 'CALLBACK_FAILED', message: error.message } }); }
}
module.exports = { handleGithubRunnerCallback, tokenMatches, readJson };
