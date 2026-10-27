const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { buildDiff } = require('./version-diff');
const { DEFAULT_LIMIT, MAX_LIMIT } = require('./version-diff');

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function patchExtendedApi() {
  const extended = require('../extended-http-api');
  if (extended.__versionDiffPatched) return;
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function patched(options = {}) {
    const result = original(options);
    if (!options.repository) return result;
    const baseListener = result.server.listeners('request')[0];
    result.server.removeAllListeners('request');
    const repository = options.repository;
    async function route(req, res) {
      const url = new URL(req.url || '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      try {
        let sourceVersionId = null, targetVersionId = null, episodeId = null;
        if (parts[0] === 'v1' && parts[1] === 'versions' && parts[2] && parts[3] === 'compare' && req.method === 'POST') {
          sourceVersionId = parts[2];
          episodeId = url.searchParams.get('episodeId');
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) return send(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE' } }); }
          const input = body ? JSON.parse(body) : {};
          targetVersionId = input.targetVersionId;
        } else if (parts[0] === 'v1' && parts[1] === 'episodes' && parts[2] && parts[3] === 'compare' && req.method === 'POST') {
          episodeId = parts[2];
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) return send(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE' } }); }
          const input = body ? JSON.parse(body) : {};
          sourceVersionId = input.sourceVersionId; targetVersionId = input.targetVersionId;
        }
        if (sourceVersionId && targetVersionId) {
          const vr = await repository.db.pool.query('SELECT id,episode_id FROM version_records WHERE id=ANY($1::text[])', [[sourceVersionId, targetVersionId]]);
          if (vr.rows.length !== 2 || new Set(vr.rows.map((x) => x.episode_id)).size !== 1) return send(res, 422, { error: { code: 'INVALID_VERSION_PAIR' } });
          episodeId = episodeId || vr.rows[0].episode_id;
          if (vr.rows.some((x) => x.episode_id !== episodeId)) return send(res, 403, { error: { code: 'FORBIDDEN' } });
          const existing = await repository.db.pool.query('SELECT * FROM forge_version_diffs WHERE episode_id=$1 AND source_version_id=$2 AND target_version_id=$3 AND schema_version=$4 AND status=\'COMPLETED\' ORDER BY created_at DESC LIMIT 1', [episodeId, sourceVersionId, targetVersionId, require('./version-diff').SCHEMA_VERSION]);
          if (existing.rows[0]) return send(res, 200, { item: existing.rows[0], reused: true });
          const key = `version-diff:${sourceVersionId}:${targetVersionId}:v1`;
          const job = await repository.db.pool.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,priority,max_attempts,idempotency_key,created_by) SELECT $1,p.project_id,$2,'workflow:version-diff',$3::jsonb,60,3,$4,$5 FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$2 ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=forge_jobs.updated_at RETURNING *`, [randomUUID(), episodeId, JSON.stringify({ sourceVersionId, targetVersionId, episodeId, schemaVersion: require('./version-diff').SCHEMA_VERSION }), key, req.headers['x-actor-id'] || 'api']);
          await repository.db.pool.query(`INSERT INTO forge_version_diffs(report_id,report_identity,episode_id,project_id,source_version_id,target_version_id,schema_version,status,created_by) SELECT $1,$1,$2,p.project_id,$3,$4,$5,'RUNNING',$6 FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$2 ON CONFLICT (report_identity) DO NOTHING`, [require('./version-diff').sha({ episodeId, sourceVersionId, targetVersionId, schemaVersion: require('./version-diff').SCHEMA_VERSION }), episodeId, sourceVersionId, targetVersionId, require('./version-diff').SCHEMA_VERSION, req.headers['x-actor-id'] || 'api']);
          return send(res, 202, { status: 'QUEUED', job: job.rows[0], sourceVersionId, targetVersionId });
        }
        if (parts[0] === 'v1' && parts[1] === 'diffs' && parts[2] && req.method === 'GET') {
          const report = await repository.db.pool.query('SELECT * FROM forge_version_diffs WHERE report_id=$1', [parts[2]]);
          return report.rows[0] ? send(res, 200, { item: report.rows[0] }) : send(res, 404, { error: { code: 'NOT_FOUND' } });
        }
        if (parts[0] === 'v1' && parts[1] === 'diffs' && parts[2] && parts[3] === 'items' && req.method === 'GET') {
          const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') || DEFAULT_LIMIT)));
          const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
          const report = await repository.db.pool.query('SELECT report_id FROM forge_version_diffs WHERE report_id=$1', [parts[2]]);
          if (!report.rows[0]) return send(res, 404, { error: { code: 'NOT_FOUND' } });
          const rows = await repository.db.pool.query('SELECT * FROM forge_version_diff_items WHERE report_id=$1 ORDER BY ordinal LIMIT $2 OFFSET $3', [parts[2], limit + 1, offset]);
          return send(res, 200, { items: rows.rows.slice(0, limit), nextOffset: rows.rows.length > limit ? offset + limit : null });
        }
        if (parts[0] === 'v1' && parts[1] === 'diffs' && parts[2] && parts[3] === 'cancel' && req.method === 'POST') {
          const report = await repository.db.pool.query('SELECT report_id FROM forge_version_diffs WHERE report_id=$1', [parts[2]]);
          if (!report.rows[0]) return send(res, 404, { error: { code: 'NOT_FOUND' } });
          await repository.db.pool.query("UPDATE forge_jobs SET cancellation_requested_at=now(),updated_at=now() WHERE kind='workflow:version-diff' AND payload->>'schemaVersion'='forge-version-diff-v1' AND payload->>'sourceVersionId'=(SELECT source_version_id FROM forge_version_diffs WHERE report_id=$1) AND payload->>'targetVersionId'=(SELECT target_version_id FROM forge_version_diffs WHERE report_id=$1) AND status IN ('QUEUED','RUNNING')", [parts[2]]);
          return send(res, 202, { status: 'CANCELLATION_REQUESTED', reportId: parts[2] });
        }
        return baseListener(req, res);
      } catch (error) {
        const status = error.statusCode || (error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'CONFLICT' ? 409 : 422);
        return send(res, status, { error: { code: error.code || 'INVALID_REQUEST', message: error.message } });
      }
    }
    result.server.on('request', route);
    return result;
  };
  extended.__versionDiffPatched = true;
}
patchExtendedApi();
module.exports = { patchExtendedApi, buildDiff };
