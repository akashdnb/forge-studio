'use strict';

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_SCAN_LIMIT = 25;

function staleCutoff(now, staleAfterMs) {
  return new Date(new Date(now).getTime() - staleAfterMs);
}

function validateOptions({ staleAfterMs = DEFAULT_STALE_AFTER_MS, limit = DEFAULT_SCAN_LIMIT } = {}) {
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1000) {
    throw new TypeError('staleAfterMs must be an integer >= 1000');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer between 1 and 100');
  }
  return { staleAfterMs, limit };
}

async function findStaleProviderRuns(pool, { now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS, limit = DEFAULT_SCAN_LIMIT } = {}) {
  const options = validateOptions({ staleAfterMs, limit });
  const cutoff = staleCutoff(now, options.staleAfterMs);
  const result = await pool.query(
    `SELECT id, episode_id, capability, provider, model, idempotency_key,
            attempt, status, external_job_id, result_artifact_ids, started_at,
            finished_at, created_at
       FROM provider_runs
      WHERE status = 'RUNNING'
        AND started_at IS NOT NULL
        AND started_at < $1
      ORDER BY started_at ASC, id ASC
      LIMIT $2`,
    [cutoff, options.limit],
  );
  return result.rows;
}

async function reconcileStaleProviderRun(pool, {
  runId,
  now = new Date(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  actor = 'provider-run-reconciler',
} = {}) {
  if (!runId || typeof runId !== 'string') throw new TypeError('runId is required');
  const { staleAfterMs: ttl } = validateOptions({ staleAfterMs, limit: 1 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query('SELECT * FROM provider_runs WHERE id = $1 FOR UPDATE', [runId]);
    const run = currentResult.rows[0];
    if (!run) {
      const error = Object.assign(new Error('Unknown provider run'), { code: 'NOT_FOUND' });
      throw error;
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      await client.query('COMMIT');
      return { reconciled: false, reason: 'TERMINAL', run };
    }
    if (run.status !== 'RUNNING') {
      await client.query('COMMIT');
      return { reconciled: false, reason: 'NOT_RUNNING', run };
    }
    if (!run.started_at || new Date(run.started_at).getTime() >= new Date(now).getTime() - ttl) {
      await client.query('COMMIT');
      return { reconciled: false, reason: 'LEASE_NOT_EXPIRED', run };
    }

    const artifacts = await client.query(
      `SELECT id, version_id, content_hash, created_at
         FROM artifacts
        WHERE provider_run_id = $1
        ORDER BY created_at ASC, id ASC`,
      [runId],
    );

    // A stale RUNNING provider call has an unknown external outcome. We never
    // replay it automatically: the provider may already have charged/succeeded.
    // Finalizing it as FAILED makes the ambiguity durable and prevents the normal
    // generation path from issuing a second paid call for the same idempotency key.
    const reconciliation = {
      code: 'PROVIDER_RUN_RECONCILIATION_REQUIRED',
      message: 'Worker lease expired while provider outcome remained uncertain; automatic replay is forbidden',
      reason: 'STALE_RUNNING_PROVIDER_RUN',
      actor,
      reconciledAt: new Date(now).toISOString(),
      requiresExternalProviderVerification: true,
      externalJobId: run.external_job_id || null,
      persistedArtifactIds: artifacts.rows.map((row) => row.id),
    };

    const updated = await client.query(
      `UPDATE provider_runs
          SET status = 'FAILED',
              error = $1::jsonb,
              finished_at = $2
        WHERE id = $3 AND status = 'RUNNING'
        RETURNING *`,
      [JSON.stringify(reconciliation), now, runId],
    );
    if (!updated.rows[0]) {
      throw Object.assign(new Error('Provider run changed while reconciling'), { code: 'STATE_CONFLICT' });
    }
    await client.query('COMMIT');
    return {
      reconciled: true,
      reason: 'STALE_RUNNING_PROVIDER_RUN',
      run: updated.rows[0],
      persistedArtifactIds: artifacts.rows.map((row) => row.id),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileStaleProviderRuns(pool, options = {}) {
  const candidates = await findStaleProviderRuns(pool, options);
  const results = [];
  for (const candidate of candidates) {
    results.push(await reconcileStaleProviderRun(pool, { ...options, runId: candidate.id }));
  }
  return results;
}

function installJobClaimHook({ intervalClaims = 25, staleAfterMs = DEFAULT_STALE_AFTER_MS, limit = DEFAULT_SCAN_LIMIT } = {}) {
  const { JobQueue } = require('../persistence/job-queue');
  if (JobQueue.prototype.__providerRunReconciliationHook) return;
  if (!Number.isInteger(intervalClaims) || intervalClaims < 1) throw new TypeError('intervalClaims must be a positive integer');

  const originalClaim = JobQueue.prototype.claim;
  let claimsSinceScan = 0;
  JobQueue.prototype.claim = async function claimWithProviderRunReconciliation(options) {
    const job = await originalClaim.call(this, options);
    claimsSinceScan += 1;
    if (claimsSinceScan >= intervalClaims) {
      claimsSinceScan = 0;
      reconcileStaleProviderRuns(this.pool, { staleAfterMs, limit }).catch((error) => {
        console.error(JSON.stringify({ event: 'provider_run.reconciliation_failed', code: error.code, message: error.message }));
      });
    }
    return job;
  };
  JobQueue.prototype.__providerRunReconciliationHook = true;
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  findStaleProviderRuns,
  reconcileStaleProviderRun,
  reconcileStaleProviderRuns,
  installJobClaimHook,
};
