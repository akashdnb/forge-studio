const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { ArtifactAccessError, verifyToken } = require('./artifact-access-gateway');
const { authenticate } = require('../security/http-security');
function bearerActor(request, apiToken, authSecret = process.env.FORGE_AUTH_SIGNING_SECRET || null) {
  const auth = authenticate(request, { apiToken, authSecret, staticActor: process.env.FORGE_STATIC_ACTOR_ID, staticTenant: process.env.FORGE_STATIC_TENANT_ID });
  return auth?.actor || null;
}
function sendJson(response, status, body, requestId) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId }); response.end(JSON.stringify(body)); }
function routeFor(request) { const url = new URL(request.url || '/', 'http://localhost'); const match = /^\/v1\/artifacts\/([^/]+)(?:\/(access-token|content))?$/.exec(url.pathname); if (!match) return null; let artifactId = match[1]; try { artifactId = decodeURIComponent(artifactId); } catch {} return { url, artifactId, action: match[2] || 'metadata' }; }
function mapError(error) { if (error instanceof ArtifactAccessError) return { status: error.statusCode, code: error.code, message: error.message }; if (error?.code === 'ARTIFACT_NOT_FOUND') return { status: 404, code: error.code, message: 'Artifact not found' }; return { status: 503, code: 'ARTIFACT_GATEWAY_ERROR', message: 'Artifact delivery is temporarily unavailable' }; }
async function handleArtifactAccess(request, response, { gateway, apiToken }) {
  const route = routeFor(request); if (!route) return false; const requestId = request.headers['x-request-id'] || randomUUID();
  try {
    if (route.action === 'access-token') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' }, requestId }, requestId);
      const actor = bearerActor(request, apiToken); if (!actor) return sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' }, requestId }, requestId);
      const action = route.url.searchParams.get('action') === 'stream' ? 'stream' : 'download';
      const issued = await gateway.issueToken({ artifactId: route.artifactId, actor, action, purpose: route.url.searchParams.get('purpose') || 'user', recovery: route.url.searchParams.get('recovery') === 'true' });
      return sendJson(response, 201, { item: issued }, requestId);
    }
    if (request.method !== 'GET') return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' }, requestId }, requestId);
    const token = route.url.searchParams.get('access_token') || route.url.searchParams.get('token');
    let actor = bearerActor(request, apiToken); let tokenPayload = null; if (token) tokenPayload = verifyToken(token, gateway.signingSecret, gateway.clock());
    if (!actor && tokenPayload) actor = tokenPayload.actor; if (!actor) return sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token or signed artifact access token is required' }, requestId }, requestId);
    if (route.action === 'metadata') { const item = await gateway.metadata({ artifactId: route.artifactId, actor, token }); return sendJson(response, 200, { item }, requestId); }
    const delivery = await gateway.open({ artifactId: route.artifactId, actor, rangeHeader: request.headers.range || null, token });
    response.writeHead(delivery.statusCode, { 'content-type': delivery.contentType, 'content-length': String(delivery.contentLength), 'content-disposition': delivery.contentDisposition, 'cache-control': 'private, max-age=60, must-revalidate', 'referrer-policy': 'no-referrer', etag: delivery.etag, 'accept-ranges': delivery.acceptRanges, 'x-content-type-options': 'nosniff', ...(delivery.contentRange ? { 'content-range': delivery.contentRange } : {}), 'x-request-id': requestId });
    delivery.stream.on('error', () => response.destroy()); delivery.stream.pipe(response); return true;
  } catch (error) { const mapped = mapError(error); return sendJson(response, mapped.status, { error: { code: mapped.code, message: mapped.message }, requestId }, requestId); }
}
module.exports = { handleArtifactAccess, routeFor, bearerActor };
