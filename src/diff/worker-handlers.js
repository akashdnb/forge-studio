const { buildDiff, persistDiff } = require('./version-diff');

function createVersionDiffHandler({ pool, maxConcurrency = Number(process.env.FORGE_DIFF_MAX_CONCURRENCY || 2), timeoutMs = Number(process.env.FORGE_DIFF_TIMEOUT_MS || 600000) } = {}) {
  if (!pool) throw new TypeError('pool is required');
  let active = 0;
  return async function handle(payload, job) {
    if (active >= maxConcurrency) throw Object.assign(new Error('Version diff concurrency limit reached'), { code: 'DIFF_SATURATED', retryable: true });
    active++;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      if (job?.cancellation_requested_at) throw Object.assign(new Error('Diff cancelled before execution'), { code: 'CANCELLED', retryable: false });
      const report = await buildDiff({ pool, episodeId: payload.episodeId, sourceVersionId: payload.sourceVersionId, targetVersionId: payload.targetVersionId, signal: controller.signal });
      const row = await persistDiff(pool, report, job?.created_by || 'system');
      return { reportId: row.report_id, reportHash: report.reportHash, changedItems: report.summary.total, durationMs: Date.now() - started, usageAccounting: { durationMs: Date.now() - started } };
    } catch (error) {
      const reportId = require('./version-diff').sha({ episodeId: payload.episodeId, sourceVersionId: payload.sourceVersionId, targetVersionId: payload.targetVersionId, schemaVersion: payload.schemaVersion || 'forge-version-diff-v1' });
      if (error.code === 'CANCELLED' || controller.signal.aborted) {
        await pool.query("UPDATE forge_version_diffs SET status='CANCELLED',error=$2::jsonb WHERE report_id=$1 AND status <> 'COMPLETED'", [reportId, JSON.stringify({ code: error.code || 'DIFF_TIMEOUT', message: error.message })]);
        error.retryable = false;
      } else {
        await pool.query("UPDATE forge_version_diffs SET status='FAILED',error=$2::jsonb WHERE report_id=$1 AND status <> 'COMPLETED'", [reportId, JSON.stringify({ code: error.code || 'DIFF_FAILED', message: error.message })]);
      }
      throw error;
    } finally {
      clearTimeout(timer); active--;
    }
  };
}

function createDiffHandlers({ pool } = {}) {
  return { 'workflow:version-diff': createVersionDiffHandler({ pool }) };
}
module.exports = { createVersionDiffHandler, createDiffHandlers };
