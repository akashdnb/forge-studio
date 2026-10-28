'use strict';

const SERIALIZATION_FAILURE = '40001';

function releaseJobPayload(row) {
  return {
    releaseExecutionId: row.id,
    publishRunId: row.publish_run_id,
    scheduleId: row.schedule_id,
    scheduleVersion: Number(row.schedule_version),
    occurrenceKey: row.occurrence_key,
    destination: row.destination,
    releaseEpoch: Number(row.release_epoch),
    gateFingerprint: row.gate_fingerprint,
  };
}

function releaseJobIdempotencyKey(row) {
  return `release-job:${row.schedule_id}:v${row.schedule_version}:${row.occurrence_key}:${row.destination}`;
}

async function enqueueMissingReleaseJob({ pool, queue, gate, transactionContext, row, workerId = 'release-scheduler', priority = 100, now = new Date() }) {
  const client = await pool.connect();
  try {
    return await transactionContext.run({ client }, async () => {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      const locked = (await client.query(`
        SELECT x.*, s.status AS schedule_status, s.current_version,
               p.status AS publish_status
          FROM forge_release_schedule_executions x
          JOIN forge_release_schedules s ON s.id=x.schedule_id
          LEFT JOIN publish_runs p ON p.id=x.publish_run_id
         WHERE x.id=$1
         FOR UPDATE OF x, s
      `, [row.id])).rows[0];

      if (!locked || locked.status !== 'QUEUED' || locked.publish_job_id) {
        await client.query('COMMIT');
        return { outcome: 'NOOP', job: null };
      }

      if (locked.publish_status === 'PUBLISHED') {
        await client.query('COMMIT');
        return { outcome: 'NOOP', job: null };
      }

      // Serialize against the mutable episode/package identity that the gate reads.
      // The parent episode lock also prevents concurrent FK-backed package insertion
      // from overtaking this transaction while the durable job is being inserted.
      await client.query('SELECT id FROM episodes WHERE id=$1 AND project_id=$2 FOR UPDATE', [locked.episode_id, locked.project_id]);
      await client.query('SELECT id FROM episode_packages WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [locked.episode_id]);

      const freshGate = await gate(
        locked.tenant_id,
        locked.project_id,
        locked.episode_id,
        locked.destination,
        now,
      );

      if (!freshGate.ok || freshGate.fingerprint !== locked.gate_fingerprint) {
        await client.query(`
          UPDATE forge_release_schedule_executions
             SET status='RECONCILIATION_REQUIRED',
                 block_reason=$2,
                 gate_snapshot=$3::jsonb,
                 gate_fingerprint=$4,
                 finished_at=COALESCE(finished_at, now()),
                 updated_at=now()
           WHERE id=$1 AND status='QUEUED' AND publish_job_id IS NULL
        `, [
          locked.id,
          !freshGate.ok
            ? (freshGate.failures || []).join(',') || 'current_gate_blocked'
            : 'gate_changed_since_scheduler_recovery',
          JSON.stringify(freshGate.snapshot || {}),
          freshGate.fingerprint || null,
        ]);
        await client.query('COMMIT');
        return { outcome: 'STALE', job: null, gate: freshGate };
      }

      const job = await queue.enqueue.call(
        { ...queue, pool: client },
        {
          projectId: locked.project_id,
          episodeId: locked.episode_id,
          kind: 'publish:scheduled',
          payload: releaseJobPayload(locked),
          priority,
          idempotencyKey: releaseJobIdempotencyKey(locked),
          createdBy: workerId,
        },
      );

      const linked = (await client.query(`
        UPDATE forge_release_schedule_executions
           SET publish_job_id=$2, status='QUEUED', updated_at=now()
         WHERE id=$1 AND status='QUEUED' AND publish_job_id IS NULL
         RETURNING id, publish_job_id
      `, [locked.id, job.id])).rows[0];

      if (!linked) {
        await client.query('ROLLBACK');
        return { outcome: 'NOOP', job: null };
      }

      await client.query('COMMIT');
      return { outcome: 'ENQUEUED', job };
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error?.code === SERIALIZATION_FAILURE) {
      return { outcome: 'RETRY', job: null, error };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { enqueueMissingReleaseJob, releaseJobPayload, releaseJobIdempotencyKey, SERIALIZATION_FAILURE };
