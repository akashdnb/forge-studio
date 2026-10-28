'use strict';

const TERMINAL_PUBLISH = new Set(['PUBLISHED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']);
const TERMINAL_JOB = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function terminalExecutionStatus(publishStatus) {
  if (publishStatus === 'PUBLISHED') return 'PUBLISHED';
  if (publishStatus === 'CANCELLED') return 'CANCELLED';
  if (publishStatus === 'RECONCILIATION_REQUIRED') return 'RECONCILIATION_REQUIRED';
  return 'FAILED';
}

function decideReconciliation(row, { currentVersion, scheduleStatus, releaseEpoch } = {}) {
  if (row.publish_status === 'PUBLISHED') return { action: 'TERMINAL', status: 'PUBLISHED' };
  if (TERMINAL_PUBLISH.has(row.publish_status)) {
    return { action: 'TERMINAL', status: terminalExecutionStatus(row.publish_status) };
  }

  const staleSchedule = scheduleStatus && !['ACTIVE', 'COMPLETED'].includes(scheduleStatus);
  const superseded = currentVersion != null && Number(currentVersion) !== Number(row.schedule_version);
  const staleEpoch = releaseEpoch != null && Number(releaseEpoch) !== Number(row.release_epoch);

  if (row.status === 'QUEUED') {
    if (!row.publish_run_id) return { action: 'RECONCILE', status: 'RECONCILIATION_REQUIRED', reason: 'missing_publish_run' };
    if (staleSchedule || superseded || staleEpoch) {
      return { action: 'TERMINAL', status: 'CANCELLED', reason: superseded ? 'stale_schedule_version' : staleEpoch ? 'stale_release_epoch' : `schedule_${String(scheduleStatus).toLowerCase()}` };
    }
    if (row.job_status == null) return { action: 'REQUEUE' };
    if (TERMINAL_JOB.has(row.job_status)) return { action: 'RECONCILE', status: 'RECONCILIATION_REQUIRED', reason: `terminal_publish_job:${row.job_status}` };
    return { action: 'NOOP' };
  }

  if (row.status === 'RUNNING') {
    if (row.job_status == null) return { action: 'RECONCILE', status: 'RECONCILIATION_REQUIRED', reason: 'missing_running_publish_job' };
    if (TERMINAL_JOB.has(row.job_status)) return { action: 'RECONCILE', status: 'RECONCILIATION_REQUIRED', reason: `terminal_running_publish_job:${row.job_status}` };
  }

  return { action: 'NOOP' };
}

async function reconcileScheduledExecutions({ pool, queue, workerId = 'release-scheduler', limit = 100, gate = null } = {}) {
  if (!pool?.query || !queue?.enqueue) throw new TypeError('pool and queue are required');
  const rows = (await pool.query(`
    SELECT x.*, j.status AS job_status, p.status AS publish_status,
           s.status AS schedule_status, s.current_version,
           COALESCE(c.release_epoch, 1) AS current_release_epoch
      FROM forge_release_schedule_executions x
      LEFT JOIN forge_jobs j ON j.id=x.publish_job_id
      LEFT JOIN publish_runs p ON p.id=x.publish_run_id
      JOIN forge_release_schedules s ON s.id=x.schedule_id
      LEFT JOIN forge_release_calendar_controls c
        ON c.tenant_id=x.tenant_id AND c.project_id=x.project_id
     WHERE x.status IN ('QUEUED','RUNNING','FAILED','RECONCILIATION_REQUIRED')
     ORDER BY x.updated_at
     LIMIT $1`, [limit])).rows;
  let fixed = 0;

  for (const row of rows) {
    const decision = decideReconciliation(row, {
      currentVersion: row.current_version,
      scheduleStatus: row.schedule_status,
      releaseEpoch: row.current_release_epoch,
    });

    if (decision.action === 'TERMINAL' || decision.action === 'RECONCILE') {
      await pool.query(
        `UPDATE forge_release_schedule_executions
            SET status=$2,
                block_reason=COALESCE($3, block_reason),
                finished_at=CASE WHEN $2 IN ('PUBLISHED','FAILED','CANCELLED','RECONCILIATION_REQUIRED') THEN COALESCE(finished_at, now()) ELSE finished_at END,
                updated_at=now()
          WHERE id=$1
            AND status <> 'PUBLISHED'`,
        [row.id, decision.status, decision.reason || null],
      );
      fixed += 1;
      continue;
    }

    if (decision.action !== 'REQUEUE') continue;

    if (gate) {
      const freshGate = await gate(row.tenant_id, row.project_id, row.episode_id, row.destination, new Date());
      if (!freshGate.ok || freshGate.fingerprint !== row.gate_fingerprint) {
        await pool.query(
          `UPDATE forge_release_schedule_executions
              SET status='RECONCILIATION_REQUIRED',
                  block_reason=$2,
                  gate_snapshot=$3::jsonb,
                  gate_fingerprint=$4,
                  finished_at=COALESCE(finished_at, now()),
                  updated_at=now()
            WHERE id=$1 AND status='QUEUED'`,
          [row.id, !freshGate.ok ? (freshGate.failures || []).join(',') || 'current_gate_blocked' : 'gate_changed_since_scheduler_recovery', JSON.stringify(freshGate.snapshot || {}), freshGate.fingerprint || null],
        );
        fixed += 1;
        continue;
      }
    }

    try {
      const job = await queue.enqueue({
        projectId: row.project_id,
        episodeId: row.episode_id,
        kind: 'publish:scheduled',
        payload: {
          releaseExecutionId: row.id,
          publishRunId: row.publish_run_id,
          scheduleId: row.schedule_id,
          scheduleVersion: Number(row.schedule_version),
          occurrenceKey: row.occurrence_key,
          destination: row.destination,
          releaseEpoch: Number(row.release_epoch),
          gateFingerprint: row.gate_fingerprint,
        },
        priority: 100,
        idempotencyKey: `release-job:${row.schedule_id}:v${row.schedule_version}:${row.occurrence_key}:${row.destination}`,
        createdBy: workerId,
      });
      await pool.query(
        `UPDATE forge_release_schedule_executions
            SET publish_job_id=$2,status='QUEUED',updated_at=now()
          WHERE id=$1 AND publish_job_id IS NULL AND status='QUEUED'`,
        [row.id, job.id],
      );
      fixed += 1;
    } catch (error) {
      await pool.query(
        `UPDATE forge_release_schedule_executions
            SET error=$2::jsonb,updated_at=now()
          WHERE id=$1 AND status='QUEUED'`,
        [row.id, JSON.stringify({ code: error.code || 'JOB_ENQUEUE_FAILED', message: error.message })],
      ).catch(() => {});
    }
  }

  return { scanned: rows.length, fixed };
}

module.exports = { decideReconciliation, reconcileScheduledExecutions, TERMINAL_JOB, TERMINAL_PUBLISH };
