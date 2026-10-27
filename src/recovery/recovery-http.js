const { URL } = require('node:url');
function json(response, status, body) { response.setHeader('content-type', 'application/json; charset=utf-8'); response.writeHead(status); response.end(JSON.stringify(body)); }
function installRecoveryRoutes(server, { service, pool, authorize }) {
  if (!server || !service || !pool) throw new TypeError('server, service and pool are required');
  server.on('request', async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/internal/recovery/')) return;
    try {
      if (!(await authorize(request))) return json(response, 403, { error: { code: 'FORBIDDEN' } });
      if (request.method !== 'GET') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      if (pathname === '/internal/recovery/health') {
        const backups = await pool.query("SELECT status,COUNT(*)::int count FROM forge_backup_records GROUP BY status ORDER BY status");
        const restores = await pool.query("SELECT status,COUNT(*)::int count FROM forge_restore_operations GROUP BY status ORDER BY status");
        const latest = await pool.query("SELECT id,status,integrity_status,coverage_status,dependency_complete,last_known_good,backup_generation,bytes,artifact_count,verified_artifact_count,snapshot_at,retention_expires_at,error_code FROM forge_backup_records ORDER BY created_at DESC LIMIT 1");
        const lkg = await pool.query("SELECT id,backup_generation,created_at,rpo_seconds,coverage_status,dependency_complete,signed_integrity_id FROM forge_backup_records WHERE status='SUCCEEDED' AND integrity_status='VERIFIED' AND last_known_good=true ORDER BY created_at DESC LIMIT 1").catch(() => ({ rows: [] }));
        const failedEvidence = await pool.query("SELECT COUNT(*)::int count FROM forge_backup_records WHERE integrity_status='FAILED'").catch(() => ({ rows: [{ count: 0 }] }));
        return json(response, 200, { status: 'ok', backupFormat: 'forge-pg-custom-v1', pitrConfigured: service.config.pitrEnabled, backups: backups.rows, restores: restores.rows, latest: latest.rows[0] || null, lastKnownGood: lkg.rows[0] || null, failedIntegrityBackups: Number(failedEvidence.rows[0].count) });
      }
      if (pathname === '/internal/recovery/rpo-rto') {
        const latest = await pool.query("SELECT snapshot_at,completed_at,bytes,artifact_count,verified_artifact_count,rpo_seconds FROM forge_backup_records WHERE status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1");
        const restore = await pool.query("SELECT started_at,completed_at,rpo_seconds,rto_ms,verification_status FROM forge_restore_operations WHERE status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1").catch(() => ({ rows: [] }));
        const row = latest.rows[0] || null; const restoreRow = restore.rows[0] || null;
        return json(response, 200, { status: 'ok', rpo: { lastSuccessfulSnapshotAt: row?.snapshot_at || null, measuredSeconds: row?.rpo_seconds ?? null, pitrConfigured: service.config.pitrEnabled, walCaptureAssumption: service.config.pitrEnabled ? 'External PostgreSQL WAL archiving is required; Forge records the snapshot WAL LSN.' : 'Backups provide discrete recovery points only.' }, rto: { lastBackupDurationMs: row?.snapshot_at && row?.completed_at ? Math.max(0, new Date(row.completed_at) - new Date(row.snapshot_at)) : null, lastVerifiedRestoreMs: restoreRow?.rto_ms ?? null, lastVerifiedRestoreRpoSeconds: restoreRow?.rpo_seconds ?? null, verificationStatus: restoreRow?.verification_status ?? null, boundedByMs: service.config.timeoutMs } });
      }
      return json(response, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) { return json(response, 500, { error: { code: error.code || 'RECOVERY_HEALTH_FAILED' } }); }
  });
}
module.exports = { installRecoveryRoutes };
