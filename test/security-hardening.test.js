const test = require('node:test');
const assert = require('node:assert/strict');
const { issueToken, verifyToken, hasRole, minimumRoleForRoute, RateLimiter, csrfAllowed } = require('../src/security/http-security');
const { verifyCallbackHeaders } = require('../src/execution/github-actions-callback');

const SECRET = '01234567890123456789012345678901';
const NOW = Date.parse('2026-10-27T00:00:00Z');

function request(method, url, headers = {}) { return { method, url, headers }; }

test('signed auth token carries tenant, actor and roles and rejects tampering', () => {
  const token = issueToken({ subject: 'actor-a', tenantId: 'tenant-a', roles: ['VIEWER'], ttlSeconds: 300, secret: SECRET, now: () => NOW });
  const claims = verifyToken(token, SECRET, () => NOW);
  assert.equal(claims.sub, 'actor-a'); assert.equal(claims.tenantId, 'tenant-a'); assert.deepEqual(claims.roles, ['VIEWER']);
  assert.equal(verifyToken(`${token}x`, SECRET, () => NOW), null);
});

test('expired and not-yet-valid tokens are rejected', () => {
  const expired = issueToken({ subject: 'a', tenantId: 't', roles: ['OWNER'], ttlSeconds: 1, secret: SECRET, now: () => NOW - 10_000 });
  assert.equal(verifyToken(expired, SECRET, () => NOW), null);
  const future = issueToken({ subject: 'a', tenantId: 't', roles: ['OWNER'], ttlSeconds: 300, secret: SECRET, now: () => NOW + 120_000 });
  assert.equal(verifyToken(future, SECRET, () => NOW), null);
});

test('role matrix enforces least privilege', () => {
  assert.equal(hasRole({ roles: ['VIEWER'] }, 'VIEWER'), true);
  assert.equal(hasRole({ roles: ['VIEWER'] }, 'EDITOR'), false);
  assert.equal(hasRole({ roles: ['EDITOR'] }, 'EDITOR'), true);
  assert.equal(hasRole({ roles: ['EDITOR'] }, 'OWNER'), false);
  assert.equal(minimumRoleForRoute(request('POST', '/v1/episodes/ep-1/approvals')), 'OWNER');
  assert.equal(minimumRoleForRoute(request('POST', '/v1/episodes/ep-1/workflow')), 'EDITOR');
  assert.equal(minimumRoleForRoute(request('GET', '/v1/episodes/ep-1')), 'VIEWER');
});

test('rate limiter bounds bursts and resets the window', () => {
  let now = 0; const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check('tenant:a').allowed, true); assert.equal(limiter.check('tenant:a').allowed, true); assert.equal(limiter.check('tenant:a').allowed, false);
  now = 1000; assert.equal(limiter.check('tenant:a').allowed, true);
});

test('cookie-backed mutations require an allowed origin while bearer-only calls do not', () => {
  const origins = new Set(['https://studio.example']);
  assert.equal(csrfAllowed(request('POST', '/v1/projects', { cookie: 'sid=x', origin: 'https://studio.example' }), origins), true);
  assert.equal(csrfAllowed(request('POST', '/v1/projects', { cookie: 'sid=x', origin: 'https://evil.example' }), origins), false);
  assert.equal(csrfAllowed(request('POST', '/v1/projects', { authorization: 'Bearer x' }), origins), true);
});

test('runner callback requires signed timestamp authentication in production mode', () => {
  const raw = JSON.stringify({ jobId: 'job-1', correlationId: 'corr-1', status: 'SUCCEEDED' });
  const timestamp = String(Math.floor(NOW / 1000));
  const secret = 'callback-secret';
  const crypto = require('node:crypto');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const req = { headers: { 'x-forge-runner-token': 'runner-token', 'x-forge-runner-timestamp': timestamp, 'x-forge-runner-signature': signature } };
  assert.equal(verifyCallbackHeaders(req, raw, { token: 'runner-token', signingSecret: secret, now: () => NOW }), true);
  assert.equal(verifyCallbackHeaders(req, raw + 'x', { token: 'runner-token', signingSecret: secret, now: () => NOW }), false);
  assert.equal(verifyCallbackHeaders({ headers: { 'x-forge-runner-token': 'runner-token', 'x-forge-runner-timestamp': timestamp } }, raw, { token: 'runner-token', signingSecret: secret, now: () => NOW }), false);
});
