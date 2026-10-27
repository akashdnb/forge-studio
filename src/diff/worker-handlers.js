const { buildDiff } = require('./enriched-diff');
const { persistDiff, sha } = require('./version-diff');
const { getActiveObservability } = require('../observability');

function createVersionDiffHandler({ pool, maxConcurrency = Number(process.env.FORGE_DIFF_MAX_CONCURRENCY || 2), timeoutMs = Number(process.env.FORGE_DIFF_TIMEOUT_MS || 600000) } = {}) {
  if (!pool) throw new TypeError('pool is required');
  let active = 0;
  return async function handle(payload, job) {
    const observability = getActiveObservability();
    if (active >= maxConcurrency) {
      observability?.metrics.inc('forge_version_diff_saturation_total', { outcome: 'rejected' });
      throw Object.assign(new Error('Version diff concurrency limit reached'), { code: 'DIFF_SATURATED', retryable: true });
    }
    active++;
    const started = process.hrtime.bigint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      if (job?.cancellation_requested_at) throw Object.assign(new Error('Diff cancelled before execution'), { code: 'CANCELLED', retryable: false });
      const report = await buildDiff({ pool, episodeId: payload.episodeId, sourceVersionId: payload.sourceVersionId, targetVersionId: payload.targetVersionId, signal: controller.signal });
      const row = await persistDiff(pool, report, job?.created_by || 'system');
      const duration = Number(process.hrtime.bigint() - started) / 1e9;
      observability?.metrics.observe('forge_version_diff_latency_seconds', { outcome: 'completed' }, duration);
      observability?.metrics.inc('forge_version_diff_jobs_total', { outcome: 'completed' });
      return { reportId: row.report_id, reportHash: report.reportHash, changedItems: report.summary.total, durationMs: Math.round(duration * 1000), usageAccounting: { durationMs: Math.round(duration * 1000) } };
    } catch (error) {
      const reportId = sha({ episodeId: payload.episodeId, sourceVersionId: payload.sourceVersionId, targetVersionId: payload.targetVersionId, schemaVersion: payload.schemaVersion || 'forge-version-diff-v1' });
      const timedOut = controller.signal.aborted;
      const finalCode = timedOut ? 'DIFF_TIMEOUT' : (error.code || 'DIFF_FAILED');
      await pool.query('UPDATE forge_version_diffs SET status=$2,error=$3::jsonb WHERE report_id=$1 AND status <> \'COMPLETED\'', [reportId, finalCode === 'CANCELLED' ? 'CANCELLED' : 'FAILED', JSON.stringify({ code: finalCode, message: error.message })]);
      const duration = Number(process.hrtime.bigint() - started) / 1e9;
      observability?.metrics.observe('forge_version_diff_latency_seconds', { outcome: finalCode.toLowerCase() }, duration);
      observability?.metrics.inc('forge_version_diff_jobs_total', { outcome: finalCode.toLowerCase() });
      error.code = finalCode; error.retryable = false; throw error;
    } finally { clearTimeout(timer); active--; }
  };
}
function createDiffHandlers({ pool } = {}) { return { 'workflow:version-diff': createVersionDiffHandler({ pool }) }; }
module.exports = { createVersionDiffHandler, createDiffHandlers };
