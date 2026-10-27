const { URL } = require('node:url');
const { authenticate, hasRole } = require('../security/http-security');

function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readJson(req, maxBytes = 65536) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'REQUEST_TOO_LARGE' }); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function installRecoveryOperatorRoutes(server, { control, authSecret, apiToken, staticActor, staticTenant }) {
  server.on('request', async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/internal/recovery/operator/')) return;
    const auth = authenticate(request, { authSecret, apiToken, staticActor, staticTenant });
    if (!auth || !hasRole(auth, 'OWNER')) return send(response, 403, { error: { code: 'RECOVERY_OPERATOR_REQUIRED' } });
    const tenantId = auth.tenantId;
    try {
      if (request.method === 'POST' && pathname === '/internal/recovery/operator/backups') {
        const body = await readJson(request);
        const result = await control.createBackup({ tenantId, actor: auth.actor, reason: body.reason || 'operator', dryRun: Boolean(body.dryRun), verifyContent: body.verifyContent !== false });
        return send(response, 202, result);
      }
      if (request.method === 'POST' && pathname === '/internal/recovery/operator/restore-plan') {
        const body = await readJson(request);
        return send(response, 200, await control.planRestore({ tenantId, actor: auth.actor, archivePath: body.archivePath, targetDatabaseUrl: body.targetDatabaseUrl }));
      }
      if (request.method === 'POST' && pathname === '/internal/recovery/operator/restore-verify') {
        const body = await readJson(request);
        return send(response, 202, await control.restoreAndVerify({ tenantId, actor: auth.actor, archivePath: body.archivePath, targetDatabaseUrl: body.targetDatabaseUrl }));
      }
      return send(response, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) { return send(response, error.code === 'RECOVERY_BUSY' ? 409 : 400, { error: { code: error.code || 'RECOVERY_OPERATION_FAILED' } }); }
  });
}
module.exports = { installRecoveryOperatorRoutes };
