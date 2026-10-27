'use strict';

const { PublishService } = require('./publish-service');
const { MediaValidationService } = require('../media/content-validation');
const { verifyPackageIntegrity } = require('../attestation/package-integrity');
const { DistributedLock, LockNotHeldError } = require('../coordination/distributed-lock');
const { redactProviderResponse } = require('./destination-contract');

/** Compatibility boundary for the legacy publish_runs/episode_packages schema. */
class RuntimePublishService extends PublishService {
  constructor(options = {}) {
    super(options);
    this.mediaValidator = new MediaValidationService({ pool: options.pool, workerId: process.env.FORGE_WORKER_ID || 'runtime-publish-validator', maxConcurrency: 1 });
    this.coordinator = options.coordinator || new DistributedLock({ pool: options.pool, ownerId: process.env.FORGE_WORKER_ID || `runtime-publisher:${process.pid}` });
    this._publishFences = new Map();
  }
  async loadRun(runId) { const run = await super.loadRun(runId); if (!run) return null; return { ...run, package_id: run.package_artifact_id, package_version_id: run.package_version_id }; }
  gate(run) { return super.gate(run); }
  async assertReadyToShip(run) {
    const result = await this.pool.query('SELECT final_ship_gate FROM episodes WHERE id=$1', [run.episode_id]);
    const gate = result.rows[0]?.final_ship_gate || {};
    if (gate.status !== 'READY_TO_SHIP') throw Object.assign(new Error('Publish blocked: final video finishing has not produced READY_TO_SHIP'), { code: 'READY_TO_SHIP_BLOCKED', retryable: false });
    if (!gate.qaId || !gate.configHash || !Array.isArray(gate.artifactIds) || !gate.artifactIds.includes(run.render_artifact_id)) throw Object.assign(new Error('Publish blocked: selected render is not covered by the READY_TO_SHIP evidence'), { code: 'READY_TO_SHIP_STALE', retryable: false });
    return gate;
  }
  async publish({ runId, job = {}, actor = 'worker' }) {
    const run = await this.loadRun(runId);
    if (run) {
      await this.assertReadyToShip(run);
      const quarantine = await this.pool.query(`SELECT 1 FROM forge_compensation_artifact_quarantines WHERE artifact_id=$1 AND status='QUARANTINED' AND tenant_id=$2 AND project_id=$3 LIMIT 1`, [run.render_artifact_id, run.tenant_id, run.project_id]);
      if (quarantine.rows[0]) throw Object.assign(new Error('Publish blocked: render artifact is quarantined by workflow compensation'), { code: 'ARTIFACT_QUARANTINED', retryable: false });
      await this.mediaValidator.assertPublishable({ tenantId: run.tenant_id, projectId: run.project_id, artifactId: run.render_artifact_id, versionId: run.render_version_id });
      const policy = (await this.pool.query(`SELECT COALESCE(MAX(revision),0)::bigint AS epoch FROM runtime_policy_heads WHERE scope_type='SYSTEM' OR (scope_type='TENANT' AND scope_id=$1) OR (scope_type='PROJECT' AND scope_id=$2)`, [run.tenant_id, run.project_id])).rows[0]?.epoch;
      const integrity = await verifyPackageIntegrity({ pool: this.pool, packageArtifactId: run.package_artifact_id, policyEpoch: policy == null ? null : Number(policy) });
      if (!integrity.ok) throw Object.assign(new Error(`Package attestation verification failed: ${integrity.diagnostics.map((item) => item.code).join(', ')}`), { code: 'PACKAGE_ATTESTATION_BLOCKED', retryable: false, diagnostics: integrity.diagnostics });
    }
    const lease = await this.coordinator.acquire({ scopeKey: `publish:${runId}`, tenantId: run?.tenant_id || null, projectId: run?.project_id || null, purpose: 'publishing-finalization', leaseMs: 60_000, waitMs: 2_000, priority: 100, metadata: { runId } });
    if (!lease.acquired) throw Object.assign(new Error('Publish finalization is owned by another process'), { code: 'PUBLISH_COORDINATION_BUSY', retryable: true });
    const renewalMs = 20_000;
    const renewal = setInterval(() => this.coordinator.renew(lease, { leaseMs: 60_000 }).catch((error) => this.logger.warn?.({ event: 'publish.coordination_renewal_failed', runId, code: error.code })), renewalMs);
    renewal.unref?.();
    this._publishFences.set(runId, lease);
    try { await this.coordinator.assertHeld(lease); return await super.publish({ runId, job, actor }); }
    finally { clearInterval(renewal); this._publishFences.delete(runId); await this.coordinator.release(lease, { reason: 'publish-finalization-complete' }).catch(() => {}); }
  }
  async recordSuccess(runId, request, attempt, result) {
    const lease = this._publishFences.get(runId);
    const safeResponse = redactProviderResponse(result?.response || {});
    const receiptId = `${request.destination}:${result.id}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (lease) await this.coordinator.assertHeld(lease, { client });
      await client.query(`INSERT INTO publish_receipts(id,tenant_id,project_id,request_id,attempt_id,destination,external_id,external_url,receipt_state,package_hash,provider_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PUBLISHED',$9,$10::jsonb) ON CONFLICT(destination,external_id) DO UPDATE SET request_id=EXCLUDED.request_id,attempt_id=EXCLUDED.attempt_id,external_url=EXCLUDED.external_url,receipt_state='PUBLISHED',provider_payload=EXCLUDED.provider_payload,observed_at=now()`, [receiptId, request.tenantId, request.projectId, request.id, attempt.id, request.destination, result.id, result.url || null, request.packageHash, JSON.stringify(safeResponse)]);
      await client.query(`UPDATE publish_attempts SET status='SUCCEEDED',external_receipt_id=$1,finished_at=$2,provider_status=201,error=NULL WHERE id=$3`, [result.id, this.now(), attempt.id]);
      const runResult = await client.query(`UPDATE publish_runs SET status='PUBLISHED',external_id=$1,external_url=$2,provider_response=$3::jsonb,upload_session_uri=NULL,finished_at=$4,error=NULL,last_provider_status=201,last_provider_reason=NULL WHERE id=$5 AND status IN ('QUEUED','UPLOADING') RETURNING id`, [result.id, result.url || null, JSON.stringify(safeResponse), this.now(), runId]);
      await client.query(`UPDATE publish_requests SET status='PUBLISHED',updated_at=$2,finished_at=$2 WHERE id=$1`, [request.id, this.now()]);
      if (runResult.rows[0]) await client.query(`UPDATE episodes SET state='PUBLISHED',published_record_id=$1,revision=revision+1,updated_at=$2 WHERE id=$3 AND state='PUBLISHING' AND approved_render_id=$4`, [runId, this.now(), request.episodeId, request.renderArtifactId]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if (error instanceof LockNotHeldError || error.code === 'COORDINATION_FENCE_LOST') Object.assign(error, { code: 'PUBLISH_COORDINATION_FENCE_LOST', terminalState: 'RECONCILIATION_REQUIRED' });
      throw error;
    } finally { client.release(); }
    this.metric('forge_publish_total', { destination: request.destination, outcome: 'success' });
    return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
  }
}
module.exports = { RuntimePublishService };
