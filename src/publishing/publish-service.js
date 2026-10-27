'use strict';

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { PublishRequest, fingerprint, redactProviderResponse } = require('./destination-contract');

function safeError(error) { return { code: error.code || 'PUBLISH_FAILED', message: error.message || String(error), status: error.status || null, providerReason: error.providerReason || null, retryable: error.retryable === true, terminalState: error.terminalState || null }; }
function isRetryable(error) { return error?.retryable === true || [408, 429, 500, 502, 503, 504].includes(error?.status); }

class PublishService {
  constructor({ pool, storage, registry, logger = console, now = () => new Date(), observability = null, maxAttempts = 3 } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    if (!storage || typeof storage.download !== 'function') throw new TypeError('storage backend is required');
    if (!registry) throw new TypeError('destination registry is required');
    this.pool = pool; this.storage = storage; this.registry = registry; this.logger = logger; this.now = now; this.observability = observability; this.maxAttempts = Math.max(1, Math.min(5, Number(maxAttempts || 3)));
  }

  async loadRun(runId) {
    const result = await this.pool.query(`SELECT p.*, e.project_id, e.state AS episode_state, e.approved_render_id, e.current_render_id, e.revision AS episode_revision, pr.tenant_id,
      a.kind AS artifact_kind, a.version_id AS artifact_version_id, a.content_hash, a.media_type, a.metadata AS artifact_metadata,
      s.storage_key, s.content_hash AS storage_hash, s.status AS storage_status,
      q.id AS qa_id, q.status AS qa_status, q.created_at AS qa_created_at,
      ap.id AS approval_id, ap.decision AS approval_decision, ap.target_id AS approval_target_id, ap.target_version_id AS approval_version_id, ap.decided_at AS approval_decided_at,
      ep.id AS package_id, ep.version_id AS package_version_id, ep.metadata_hash, ep.manifest_hash AS package_hash, ep.status AS package_status,
      rs.epoch AS release_epoch
      FROM publish_runs p
      JOIN episodes e ON e.id=p.episode_id
      JOIN projects pr ON pr.id=e.project_id
      JOIN artifacts a ON a.id=p.render_artifact_id
      LEFT JOIN storage_objects s ON s.artifact_id=a.id
      LEFT JOIN LATERAL (SELECT id,status,created_at FROM qa_results WHERE artifact_id=a.id AND version_id=a.version_id ORDER BY created_at DESC LIMIT 1) q ON true
      LEFT JOIN LATERAL (SELECT id,decision,target_id,target_version_id,decided_at FROM approvals WHERE episode_id=p.episode_id AND stage='FINAL_RENDER' ORDER BY decided_at DESC LIMIT 1) ap ON true
      LEFT JOIN episode_packages ep ON ep.id=p.package_artifact_id AND ep.version_id=p.package_version_id
      LEFT JOIN forge_release_state rs ON rs.id=true
      WHERE p.id=$1`, [runId]);
    return result.rows[0] || null;
  }

  gate(run) {
    if (!run) throw Object.assign(new Error('Publish run not found'), { code: 'NOT_FOUND', retryable: false });
    if (!this.registry.get(run.destination)) return false;
    if (!['APPROVED', 'PUBLISHING'].includes(run.episode_state)) throw Object.assign(new Error('Episode is not approved for publication'), { code: 'RELEASE_GATE_BLOCKED', retryable: false });
    if (run.approved_render_id !== run.render_artifact_id || run.current_render_id !== run.render_artifact_id) throw Object.assign(new Error('Publish render is stale or no longer selected'), { code: 'STALE_ARTIFACT', retryable: false });
    if (run.artifact_kind !== 'render' || run.artifact_version_id !== run.render_version_id) throw Object.assign(new Error('Publish artifact/version provenance mismatch'), { code: 'INVALID_PROVENANCE', retryable: false });
    if (!run.content_hash || !/^[a-f0-9]{64}$/.test(run.content_hash)) throw Object.assign(new Error('Approved render has no trusted checksum'), { code: 'INVALID_PROVENANCE', retryable: false });
    if (run.storage_hash && run.storage_hash !== run.content_hash) throw Object.assign(new Error('Stored render checksum does not match artifact checksum'), { code: 'CHECKSUM_MISMATCH', retryable: false });
    if (!run.storage_key || run.storage_status !== 'READY') throw Object.assign(new Error('Approved render storage is not ready'), { code: 'ARTIFACT_UNAVAILABLE', retryable: false });
    if (run.media_type !== 'video/mp4') throw Object.assign(new Error('Only video/mp4 renders are publishable'), { code: 'INVALID_MEDIA_TYPE', retryable: false });
    if (!['PASSED', 'WARNINGS'].includes(run.qa_status)) throw Object.assign(new Error('Latest QA result is not passing'), { code: 'QA_BLOCKED', retryable: false });
    if (run.approval_decision !== 'APPROVED' || run.approval_target_id !== run.render_artifact_id || run.approval_version_id !== run.render_version_id) throw Object.assign(new Error('Final render approval does not match publish artifact'), { code: 'APPROVAL_BLOCKED', retryable: false });
    if (run.package_status !== 'READY' || run.package_id !== run.package_artifact_id || run.package_version_id !== run.package_version_id || !run.package_hash) throw Object.assign(new Error('Canonical package is not ready or no longer matches the publish request'), { code: 'PACKAGE_INVALID', retryable: false });
    return true;
  }

  gateSnapshot(run) {
    return { episodeState: run.episode_state, episodeRevision: run.episode_revision, renderArtifactId: run.render_artifact_id, renderVersionId: run.render_version_id, renderHash: run.content_hash, packageArtifactId: run.package_artifact_id, packageVersionId: run.package_version_id, packageHash: run.package_hash, qaId: run.qa_id, qaStatus: run.qa_status, qaCreatedAt: run.qa_created_at, approvalId: run.approval_id, approvalDecision: run.approval_decision, approvalTargetId: run.approval_target_id, approvalVersionId: run.approval_version_id, approvalDecidedAt: run.approval_decided_at, releaseEpoch: run.release_epoch };
  }

  async ensureRequest(run, actor = 'worker') {
    const requestId = run.publish_request_id || randomUUID();
    const snapshot = this.gateSnapshot(run);
    const request = new PublishRequest({ id: requestId, tenantId: run.tenant_id, projectId: run.project_id, episodeId: run.episode_id, destination: run.destination, idempotencyKey: run.idempotency_key, packageArtifactId: run.package_artifact_id, packageVersionId: run.package_version_id, packageHash: run.package_hash, renderArtifactId: run.render_artifact_id, renderVersionId: run.render_version_id, renderHash: run.content_hash, metadata: run.metadata, gateSnapshot: snapshot, gateFingerprint: fingerprint(snapshot), releaseEpoch: run.release_epoch });
    const inserted = await this.pool.query(`INSERT INTO publish_requests(id,tenant_id,project_id,episode_id,destination,request_version,idempotency_key,package_artifact_id,package_version_id,package_hash,render_artifact_id,render_version_id,render_hash,metadata,gate_snapshot,gate_fingerprint,release_epoch,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,'QUEUED',$18)
      ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=now() RETURNING id,gate_fingerprint,release_epoch,status`, [request.id, request.tenantId, request.projectId, request.episodeId, request.destination, request.requestVersion, request.idempotencyKey, request.packageArtifactId, request.packageVersionId, request.packageHash, request.renderArtifactId, request.renderVersionId, request.renderHash, JSON.stringify(request.metadata), JSON.stringify(request.gateSnapshot), request.gateFingerprint, request.releaseEpoch, actor]);
    await this.pool.query('UPDATE publish_runs SET publish_request_id=$1,project_id=$2,tenant_id=$3,package_hash=$4,gate_fingerprint=$5,release_epoch=$6 WHERE id=$7', [inserted.rows[0].id, request.projectId, request.tenantId, request.packageHash, request.gateFingerprint, request.releaseEpoch, run.id]);
    return { request, persisted: inserted.rows[0] };
  }

  async claimAttempt(request, run, job = {}) {
    const attemptNo = Math.max(1, Number(job.attempts || run.attempt || 1));
    const attemptId = `${request.id}:attempt:${attemptNo}`;
    const operationKey = `${request.destination}:${request.id}:attempt:${attemptNo}`;
    const providerRequestKey = `${request.destination}:${request.id}`;
    const result = await this.pool.query(`INSERT INTO publish_attempts(id,request_id,attempt_no,status,operation_key,provider_request_key,release_epoch,lease_token,started_at)
      VALUES($1,$2,$3,'UPLOADING',$4,$5,$6,$7,$8)
      ON CONFLICT(request_id,attempt_no) DO UPDATE SET status='UPLOADING',lease_token=EXCLUDED.lease_token,started_at=COALESCE(publish_attempts.started_at,EXCLUDED.started_at)
      RETURNING *`, [attemptId, request.id, attemptNo, operationKey, providerRequestKey, request.releaseEpoch, randomUUID(), this.now()]);
    return result.rows[0];
  }

  async publish({ runId, job = {}, actor = 'worker' }) {
    let run = await this.loadRun(runId);
    if (!run) throw Object.assign(new Error(`Unknown publish run ${runId}`), { code: 'NOT_FOUND', retryable: false });
    if (run.status === 'PUBLISHED') return { publishRunId: runId, externalId: run.external_id, externalUrl: run.external_url, alreadyPublished: true };
    if (['CANCELLED', 'RECONCILIATION_REQUIRED', 'QUARANTINED'].includes(run.status)) throw Object.assign(new Error(`Publish run is terminal: ${run.status}`), { code: run.status, retryable: false });
    this.gate(run);
    const { request } = await this.ensureRequest(run, actor);
    if (request.releaseEpoch != null && run.release_epoch != null && Number(request.releaseEpoch) !== Number(run.release_epoch)) throw Object.assign(new Error('Publish release epoch changed'), { code: 'STALE_RELEASE_EPOCH', retryable: false, terminalState: 'RECONCILIATION_REQUIRED' });
    const fresh = await this.loadRun(runId);
    this.gate(fresh);
    const freshFingerprint = fingerprint(this.gateSnapshot(fresh));
    if (freshFingerprint !== request.gateFingerprint) throw Object.assign(new Error('Publish gate state changed after request creation'), { code: 'GATE_CHANGED', retryable: false, terminalState: 'RECONCILIATION_REQUIRED' });

    const receipt = await this.pool.query('SELECT * FROM publish_receipts WHERE request_id=$1 ORDER BY observed_at DESC LIMIT 1', [request.id]);
    if (receipt.rows[0]?.receipt_state === 'PUBLISHED') return this.completeFromReceipt(run, receipt.rows[0]);

    const adapter = this.registry.get(request.destination);
    adapter.validateRequest(request);
    const attempt = await this.claimAttempt(request, fresh, job);
    const artifact = await this.materializeTrustedArtifact(fresh);
    const controller = new AbortController();
    const cancellation = this.watchCancellation(job.id, controller);
    try {
      await this.rateLimit(request.tenantId, request.destination);
      const result = await adapter.publish({ request, sourcePath: artifact.path, externalId: fresh.external_id || attempt.external_receipt_id || null, uploadSessionUri: attempt.upload_session_uri || fresh.upload_session_uri || null, signal: controller.signal, onSession: async (uri) => { await this.pool.query('UPDATE publish_attempts SET upload_session_uri=$1,diagnostics=diagnostics||$2::jsonb WHERE id=$3', [uri, JSON.stringify({ uploadSessionPersistedAt: this.now().toISOString() }), attempt.id]); await this.pool.query('UPDATE publish_runs SET upload_session_uri=$1 WHERE id=$2', [uri, runId]); } });
      return await this.recordSuccess(runId, request, attempt, result);
    } catch (error) {
      return this.recordFailure(runId, request, attempt, error, job);
    } finally { clearInterval(cancellation); await fsp.rm(artifact.path, { force: true }).catch(() => {}); }
  }

  async recordSuccess(runId, request, attempt, result) {
    const safeResponse = redactProviderResponse(result?.response || {});
    const receiptId = `${request.destination}:${result.id}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO publish_receipts(id,tenant_id,project_id,request_id,attempt_id,destination,external_id,external_url,receipt_state,package_hash,provider_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PUBLISHED',$9,$10::jsonb) ON CONFLICT(destination,external_id) DO UPDATE SET request_id=EXCLUDED.request_id,attempt_id=EXCLUDED.attempt_id,external_url=EXCLUDED.external_url,receipt_state='PUBLISHED',provider_payload=EXCLUDED.provider_payload,observed_at=now()`, [receiptId, request.tenantId, request.projectId, request.id, attempt.id, request.destination, result.id, result.url || null, request.packageHash, JSON.stringify(safeResponse)]);
      await client.query(`UPDATE publish_attempts SET status='SUCCEEDED',external_receipt_id=$1,finished_at=$2,provider_status=201,error=NULL WHERE id=$3`, [result.id, this.now(), attempt.id]);
      const runResult = await client.query(`UPDATE publish_runs SET status='PUBLISHED',external_id=$1,external_url=$2,provider_response=$3::jsonb,upload_session_uri=NULL,finished_at=$4,error=NULL,last_provider_status=201,last_provider_reason=NULL WHERE id=$5 AND status IN ('QUEUED','UPLOADING') RETURNING id`, [result.id, result.url || null, JSON.stringify(safeResponse), this.now(), runId]);
      await client.query(`UPDATE publish_requests SET status='PUBLISHED',updated_at=$2,finished_at=$2 WHERE id=$1`, [request.id, this.now()]);
      if (runResult.rows[0]) await client.query(`UPDATE episodes SET state='PUBLISHED',published_record_id=$1,revision=revision+1,updated_at=$2 WHERE id=$3 AND state='PUBLISHING' AND approved_render_id=$4`, [runId, this.now(), request.episodeId, request.renderArtifactId]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
    this.metric('forge_publish_total', { destination: request.destination, outcome: 'success' });
    return { publishRunId: runId, externalId: result.id, externalUrl: result.url, reconciled: Boolean(result.reconciled) };
  }

  async recordFailure(runId, request, attempt, error, job) {
    const uncertain = error.terminalState === 'RECONCILIATION_REQUIRED' || error.code === 'PROVIDER_TIMEOUT' || error.code === 'NETWORK_ERROR' || error.code === 'UPLOAD_SESSION_EXPIRED';
    const retryable = !uncertain && isRetryable(error);
    const maxed = Number(job.attempts || 1) >= Number(job.max_attempts || this.maxAttempts);
    const status = uncertain ? 'UNCERTAIN' : (retryable && !maxed ? 'FAILED' : (error.code === 'JOB_CANCELLED' ? 'CANCELLED' : 'FAILED'));
    await this.pool.query(`UPDATE publish_attempts SET status=$1,provider_status=$2,provider_reason=$3,error=$4::jsonb,finished_at=$5 WHERE id=$6`, [status, error.status || null, error.providerReason || error.code || null, JSON.stringify(safeError(error)), this.now(), attempt.id]);
    await this.pool.query(`UPDATE publish_requests SET status=$1,updated_at=$2,finished_at=CASE WHEN $1 IN ('FAILED','CANCELLED','RECONCILIATION_REQUIRED') THEN $2 ELSE finished_at END WHERE id=$3`, [uncertain ? 'RECONCILIATION_REQUIRED' : (error.code === 'JOB_CANCELLED' ? 'CANCELLED' : (retryable && !maxed ? 'UPLOADING' : 'FAILED')), this.now(), request.id]);
    await this.pool.query(`UPDATE publish_runs SET status=$1,last_provider_status=$2,last_provider_reason=$3,error=$4::jsonb,finished_at=CASE WHEN $1 IN ('FAILED','CANCELLED','RECONCILIATION_REQUIRED') THEN $5 ELSE finished_at END WHERE id=$6`, [uncertain ? 'RECONCILIATION_REQUIRED' : (error.code === 'JOB_CANCELLED' ? 'CANCELLED' : (retryable && !maxed ? 'UPLOADING' : 'FAILED')), error.status || null, error.providerReason || error.code || null, JSON.stringify(safeError(error)), this.now(), runId]);
    if (uncertain) await this.raiseIncident(request, error);
    this.metric('forge_publish_total', { destination: request.destination, outcome: uncertain ? 'uncertain' : 'failure' });
    this.logger.error?.({ event: 'publish.failed', publishRunId: runId, destination: request.destination, code: error.code, status: error.status, uncertain });
    throw Object.assign(error, { retryable: uncertain ? false : retryable });
  }

  async reconcile(runId, actor = 'operator') {
    const run = await this.loadRun(runId); if (!run) throw Object.assign(new Error('Publish run not found'), { code: 'NOT_FOUND' });
    const request = (await this.pool.query('SELECT * FROM publish_requests WHERE id=$1', [run.publish_request_id])).rows[0];
    if (!request) throw Object.assign(new Error('Publish request not found'), { code: 'NOT_FOUND' });
    const adapter = this.registry.get(request.destination);
    const externalId = run.external_id || (await this.pool.query('SELECT external_receipt_id FROM publish_attempts WHERE request_id=$1 AND external_receipt_id IS NOT NULL ORDER BY attempt_no DESC LIMIT 1', [request.id])).rows[0]?.external_receipt_id;
    const result = await adapter.reconcile({ request, externalId });
    await this.pool.query('INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [request.project_id, request.episode_id, actor, 'PUBLISH_RECONCILE', 'publish_request', request.id, JSON.stringify({ destination: request.destination, state: result.state, externalId })]);
    if (result.state === 'PUBLISHED' && result.externalId) {
      await this.recordSuccess(runId, request, { id: `${request.id}:reconcile`, attempt_no: 0 }, result);
      return { status: 'PUBLISHED', reconciled: true, externalId: result.externalId, externalUrl: result.url };
    }
    return { status: 'UNKNOWN', reconciled: false, externalId: externalId || null };
  }

  async cancel(runId, actor = 'operator', reason = 'operator cancellation') {
    const run = await this.loadRun(runId); if (!run) throw Object.assign(new Error('Publish run not found'), { code: 'NOT_FOUND' });
    await this.pool.query(`UPDATE publish_runs SET status='CANCELLED',quarantine_reason=$1,finished_at=$2 WHERE id=$3 AND status IN ('QUEUED','UPLOADING','RECONCILIATION_REQUIRED')`, [reason, this.now(), runId]);
    if (run.publish_request_id) await this.pool.query(`UPDATE publish_requests SET status='CANCELLED',updated_at=$1,finished_at=$1 WHERE id=$2`, [this.now(), run.publish_request_id]);
    await this.audit(run, actor, 'PUBLISH_CANCEL', { reason });
    return { status: 'CANCELLED' };
  }

  async quarantine(runId, actor = 'operator', reason = 'operator quarantine') {
    const run = await this.loadRun(runId); if (!run) throw Object.assign(new Error('Publish run not found'), { code: 'NOT_FOUND' });
    if (!run.publish_request_id) await this.ensureRequest(run, actor);
    await this.pool.query(`INSERT INTO publish_quarantine(id,tenant_id,project_id,request_id,reason,evidence,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [randomUUID(), run.tenant_id, run.project_id, run.publish_request_id, reason, JSON.stringify({ publishRunId: runId, status: run.status, externalId: run.external_id }), actor]);
    await this.pool.query(`UPDATE publish_runs SET status='QUARANTINED',quarantine_reason=$1,finished_at=$2 WHERE id=$3`, [reason, this.now(), runId]);
    await this.pool.query(`UPDATE publish_requests SET status='QUARANTINED',updated_at=$1 WHERE id=$2`, [this.now(), run.publish_request_id]);
    await this.audit(run, actor, 'PUBLISH_QUARANTINE', { reason });
    return { status: 'QUARANTINED' };
  }

  async retry(runId, actor = 'operator') {
    const run = await this.loadRun(runId); if (!run) throw Object.assign(new Error('Publish run not found'), { code: 'NOT_FOUND' });
    if (!['FAILED'].includes(run.status)) throw Object.assign(new Error('Only failed publish runs may be retried'), { code: 'STATE_CONFLICT' });
    this.gate(run);
    const freshFingerprint = fingerprint(this.gateSnapshot(run));
    if (run.gate_fingerprint && freshFingerprint !== run.gate_fingerprint) throw Object.assign(new Error('Publish gate state changed; create a new publish request instead of retrying'), { code: 'GATE_CHANGED' });
    await this.pool.query(`UPDATE publish_runs SET status='QUEUED',error=NULL,finished_at=NULL,attempt=attempt+1 WHERE id=$1`, [runId]);
    await this.pool.query(`UPDATE publish_requests SET status='QUEUED',updated_at=$1 WHERE id=$2`, [this.now(), run.publish_request_id]);
    await this.audit(run, actor, 'PUBLISH_RETRY', { attempt: Number(run.attempt || 1) + 1 });
    return { status: 'QUEUED' };
  }

  async rateLimit(tenantId, destination) {
    const windowSeconds = Math.max(1, Number(process.env.FORGE_PUBLISH_RATE_WINDOW_SECONDS || 60));
    const max = Math.max(1, Number(process.env.FORGE_PUBLISH_RATE_LIMIT || 10));
    const bucket = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
    const result = await this.pool.query(`INSERT INTO publish_rate_buckets(tenant_id,destination,window_start,request_count) VALUES($1,$2,$3,1) ON CONFLICT(tenant_id,destination,window_start) DO UPDATE SET request_count=publish_rate_buckets.request_count+1 RETURNING request_count`, [tenantId, destination, bucket]);
    if (Number(result.rows[0].request_count) > max) throw Object.assign(new Error('Destination rate limit exceeded'), { code: 'DESTINATION_RATE_LIMIT', status: 429, retryable: true });
  }

  async raiseIncident(request, error) {
    if (!request.tenantId || !request.projectId) return;
    const fp = fingerprint({ tenantId: request.tenantId, projectId: request.projectId, destination: request.destination, code: error.code || 'PUBLISH_UNCERTAIN' });
    const id = `publish:${fp}`;
    try {
      await this.pool.query(`INSERT INTO operational_incidents(id,tenant_id,project_id,rule_key,fingerprint,group_key,severity,status,title,summary,source_type,source_id,evidence)
        VALUES($1,$2,$3,'publish_reconciliation','${fp}','$4','ERROR','OPEN','Publishing reconciliation required',$5,'publish_request',$6,$7::jsonb)
        ON CONFLICT(tenant_id,fingerprint) WHERE status IN ('OPEN','ACKNOWLEDGED','SUPPRESSED') DO UPDATE SET last_seen_at=now(),occurrence_count=operational_incidents.occurrence_count+1,evidence=EXCLUDED.evidence,updated_at=now()`, [id, request.tenantId, request.projectId, fp, `Uncertain ${request.destination} publication outcome: ${error.code || 'unknown'}`, request.id, JSON.stringify({ destination: request.destination, code: error.code, status: error.status })]);
    } catch (incidentError) { this.logger.warn?.(`Could not raise publish incident: ${incidentError.message}`); }
  }

  async audit(run, actor, action, details = {}) { await this.pool.query('INSERT INTO audit_events(project_id,episode_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [run.project_id, run.episode_id, actor, action, 'publish_run', run.id, JSON.stringify(details)]); }
  async completeFromReceipt(run, receipt) { return { publishRunId: run.id, externalId: receipt.external_id, externalUrl: receipt.external_url, reconciled: true }; }
  async materializeTrustedArtifact(run) {
    const temp = path.join(os.tmpdir(), `forge-publish-${run.id}-${randomUUID()}.mp4`);
    const resolved = await this.storage.download({ key: run.storage_key, expectedSha256: run.content_hash });
    await pipeline(resolved.stream, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => { const stream = fs.createReadStream(temp); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolve); });
    if (hash.digest('hex') !== run.content_hash) { await fsp.rm(temp, { force: true }).catch(() => {}); throw Object.assign(new Error('Materialized artifact checksum mismatch'), { code: 'CHECKSUM_MISMATCH', retryable: false }); }
    return { path: temp };
  }
  watchCancellation(jobId, controller) { if (!jobId) return null; const timer = setInterval(() => { this.pool.query('SELECT status FROM forge_jobs WHERE id=$1', [jobId]).then((r) => { if (r.rows[0]?.status === 'CANCELLED') controller.abort(); }).catch(() => {}); }, 2000); timer.unref?.(); return timer; }
  metric(name, labels) { try { this.observability?.metrics?.inc(name, labels); } catch {} }
}

module.exports = { PublishService, safeError, isRetryable };
