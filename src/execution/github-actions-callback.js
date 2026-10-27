const { timingSafeEqual, createHmac } = require('node:crypto');
const { createGithubActionsExecutionBackend } = require('./github-actions-backend');
const JSON_LIMIT_BYTES = 256 * 1024;
function tokenMatches(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a = Buffer.from(expected), b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
function signature(secret, timestamp, raw) { return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex'); }
async function readRaw(req) { let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > JSON_LIMIT_BYTES) throw Object.assign(new Error('Callback body exceeds 256 KiB'), { statusCode: 413 }); chunks.push(chunk); } return Buffer.concat(chunks).toString('utf8'); }
function parseJson(raw) { try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('Malformed callback JSON'), { statusCode: 400 }); } }
async function readJson(req) { return parseJson(await readRaw(req)); }
function json(res, status, body) { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function verifyCallbackHeaders(req, raw, { token, signingSecret = process.env.FORGE_RUNNER_CALLBACK_SIGNING_SECRET, now = Date.now, maxSkewSeconds = Number(process.env.FORGE_RUNNER_CALLBACK_MAX_SKEW_SECONDS || 300) }) {
  const staticTokenValid = tokenMatches(token, req.headers['x-forge-runner-token']);
  if (process.env.NODE_ENV !== 'production' && process.env.FORGE_ALLOW_LEGACY_CALLBACK_TOKEN === 'true' && staticTokenValid) return true;
  if (!signingSecret || !staticTokenValid) return false;
  const timestamp = String(req.headers['x-forge-runner-timestamp'] || ''); const received = String(req.headers['x-forge-runner-signature'] || '');
  const seconds = Number(timestamp); if (!Number.isFinite(seconds) || Math.abs(Math.floor(now() / 1000) - seconds) > maxSkewSeconds || !/^[a-f0-9]{64}$/.test(received)) return false;
  return tokenMatches(signature(signingSecret, timestamp, raw), received);
}
async function handleGithubRunnerCallback(req, res, { pool, token = process.env.FORGE_RUNNER_CALLBACK_TOKEN, logger = console } = {}) {
  if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  try {
    const raw = await readRaw(req);
    if (!verifyCallbackHeaders(req, raw, { token })) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid runner callback authentication' } });
    const body = parseJson(raw);
    for (const field of ['jobId', 'correlationId', 'status']) if (typeof body[field] !== 'string' || !body[field]) throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
    const replay = await pool.query('INSERT INTO webhook_replay_keys(scope,replay_key,expires_at) VALUES($1,$2,now()+interval \'15 minutes\') ON CONFLICT DO NOTHING RETURNING replay_key', ['github-runner', `${body.jobId}:${body.correlationId}:${req.headers['x-forge-runner-timestamp'] || 'legacy'}`]);
    if (!replay.rows[0]) throw Object.assign(new Error('Replay rejected'), { code: 'WEBHOOK_REPLAY', statusCode: 409 });
    const execution = (await pool.query('SELECT * FROM forge_execution_runs WHERE job_id=$1 AND correlation_id=$2', [body.jobId, body.correlationId])).rows[0];
    const job = (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [body.jobId])).rows[0];
    if (!execution || !job) throw Object.assign(new Error('Unknown runner execution'), { code: 'NOT_FOUND' });
    if (Number(execution.attempt) !== Number(job.attempts) || job.status !== 'RUNNING') throw Object.assign(new Error('Stale runner execution cannot mutate the current job attempt'), { code: 'STALE_EXECUTION', statusCode: 409 });
    const backend = createGithubActionsExecutionBackend({ pool, queue: { get: async (id) => (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [id])).rows[0] || null }, config: { mode: 'local', ref: 'callback', timeoutMs: 1800000, dispatchGraceMs: 60000, maxDispatchesPerTick: 0 }, client: { cancel: async () => true }, logger });
    return json(res, 200, { item: await backend.applyCallback({ jobId: body.jobId, correlationId: body.correlationId, status: body.status, githubRunId: body.githubRunId || null, githubRunAttempt: body.githubRunAttempt || null, metadata: body.metadata || {} }) });
  } catch (error) { return json(res, error.statusCode || (error.code === 'NOT_FOUND' ? 404 : 422), { error: { code: error.code || 'CALLBACK_FAILED', message: error.message } }); }
}
module.exports = { handleGithubRunnerCallback, tokenMatches, readJson, readRaw, verifyCallbackHeaders };
