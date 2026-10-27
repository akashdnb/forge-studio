'use strict';
const { JobQueue } = require('../persistence/job-queue');
const { PublicGithubActionsExecutionBackend } = require('../execution/public-github-actions-backend');
const callback = require('../execution/github-actions-callback');
const { DeploymentSafetyService } = require('./deployment-safety');

function installWorkerReleaseGuards() {
  if (JobQueue.prototype.__forgeReleaseGuards) return;
  JobQueue.prototype.__forgeReleaseGuards = true;
  const originalClaim = JobQueue.prototype.claim;
  const originalClaimSpecific = JobQueue.prototype.claimSpecific;
  async function admit(queue, job, workerId) {
    if (!job) return null;
    const state = (await queue.pool.query('SELECT * FROM forge_release_state WHERE id=true')).rows[0];
    if (!state?.active_release_id) return job;
    const manifest = (await queue.pool.query('SELECT * FROM forge_release_manifests WHERE release_id=$1', [state.active_release_id])).rows[0];
    if (!manifest || state.state === 'ROLL_FORWARD_REQUIRED' || state.state === 'ROLLBACK_INTERRUPTED') {
      await queue.pool.query("UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=now(),updated_at=now(),error=$1::jsonb WHERE id=$2 AND status='RUNNING'", [JSON.stringify({ code: 'RELEASE_BLOCKED', message: 'No safe active release' }), job.id]);
      return null;
    }
    const schema = job.required_schema_version || manifest.schema_version;
    const protocol = job.required_protocol_version || manifest.required_protocol_version;
    const compatible = (!job.required_release_epoch || job.required_release_epoch === state.epoch || manifest.compatibility_window?.allowPreviousEpoch === true) && (!schema || (String(schema) >= String(manifest.min_schema_version) && String(schema) <= String(manifest.max_schema_version))) && (!protocol || String(protocol) === String(manifest.required_protocol_version));
    if (!compatible) {
      await queue.pool.query("UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,available_at=now(),updated_at=now(),error=$1::jsonb WHERE id=$2 AND status='RUNNING'", [JSON.stringify({ code: 'RELEASE_INCOMPATIBLE_JOB', message: 'Job schema/protocol/release epoch is incompatible with the active release' }), job.id]);
      return null;
    }
    const admission = await new DeploymentSafetyService({ pool: queue.pool }).pool.query("INSERT INTO forge_worker_fences(worker_id,release_id,app_version,schema_version,status,last_seen_at,metadata) VALUES($1,$2,$3,$4,'ACTIVE',now(),$5::jsonb) ON CONFLICT(worker_id) DO UPDATE SET release_id=EXCLUDED.release_id,app_version=EXCLUDED.app_version,schema_version=EXCLUDED.schema_version,status='ACTIVE',last_seen_at=now(),metadata=EXCLUDED.metadata RETURNING worker_id", [workerId, state.active_release_id, process.env.FORGE_APP_VERSION || '0.0.0', schema, JSON.stringify({ protocolVersion: protocol, epoch: state.epoch })]);
    if (!admission.rows[0]) throw Object.assign(new Error('Worker admission failed'), { code: 'WORKER_FENCED' });
    return job;
  }
  JobQueue.prototype.claim = async function releaseGuardedClaim(options) { return admit(this, await originalClaim.call(this, options), options?.workerId); };
  JobQueue.prototype.claimSpecific = async function releaseGuardedClaimSpecific(id, workerId, now) { return admit(this, await originalClaimSpecific.call(this, id, workerId, now), workerId); };
}

function installPublicRunnerEpochGuards() {
  if (PublicGithubActionsExecutionBackend.prototype.__forgeReleaseEpochGuards) return;
  PublicGithubActionsExecutionBackend.prototype.__forgeReleaseEpochGuards = true;
  const originalDispatch = PublicGithubActionsExecutionBackend.prototype.dispatchClaimed;
  const originalReconcile = PublicGithubActionsExecutionBackend.prototype.reconcileExecution;
  PublicGithubActionsExecutionBackend.prototype.dispatchClaimed = async function releaseEpochDispatch(args) {
    const state = (await this.pool.query('SELECT active_release_id,epoch,state FROM forge_release_state WHERE id=true')).rows[0];
    if (state?.active_release_id && state.state !== 'ROLL_FORWARD_REQUIRED' && state.state !== 'ROLLBACK_INTERRUPTED') {
      args.job.release_id = state.active_release_id;
      args.job.release_epoch = state.epoch;
    }
    const result = await originalDispatch.call(this, args);
    if (result && state?.active_release_id) await this.pool.query('UPDATE forge_execution_runs SET release_id=$1,release_epoch=$2 WHERE id=$3', [state.active_release_id, state.epoch, result.id]);
    return result;
  };
  PublicGithubActionsExecutionBackend.prototype.reconcileExecution = async function releaseEpochReconcile(execution) {
    const state = (await this.pool.query('SELECT active_release_id,epoch,state FROM forge_release_state WHERE id=true')).rows[0];
    if (execution.release_epoch != null && state && Number(execution.release_epoch) !== Number(state.epoch)) {
      await this.setExecutionStatus(execution.id, 'STALE', { failureCode: 'RELEASE_EPOCH_STALE', failureMessage: 'Public runner execution belongs to an older deployment epoch' });
      return;
    }
    return originalReconcile.call(this, execution);
  };
}

function installPublicRunnerCallbackEpochGuard() {
  if (callback.__forgeReleaseEpochGuard) return;
  const original = callback.handleGithubRunnerCallback;
  callback.handleGithubRunnerCallback = async function releaseEpochCallback(req, res, options = {}) {
    if (req.method === 'POST' && options.pool) {
      const rawChunks=[]; for await(const chunk of req){rawChunks.push(chunk)}
      const raw=Buffer.concat(rawChunks); const body=JSON.parse(raw.toString('utf8'));
      const execution=(await options.pool.query('SELECT release_epoch FROM forge_execution_runs WHERE job_id=$1 AND correlation_id=$2',[body.jobId,body.correlationId])).rows[0];
      const state=(await options.pool.query('SELECT epoch FROM forge_release_state WHERE id=true')).rows[0];
      if (execution?.release_epoch != null && state?.epoch != null && Number(execution.release_epoch)!==Number(state.epoch)) { res.writeHead(409,{'content-type':'application/json'}); return res.end(JSON.stringify({error:{code:'STALE_RELEASE_EPOCH'}})); }
      const replayReq = new (require('node:stream').Readable)({read(){this.push(raw);this.push(null)}}); Object.assign(replayReq,req); return original(replayReq,res,options);
    }
    return original(req,res,options);
  };
  callback.__forgeReleaseEpochGuard=true;
}

function installReleaseRuntimeGuards() { installWorkerReleaseGuards(); installPublicRunnerEpochGuards(); installPublicRunnerCallbackEpochGuard(); }
module.exports = { installWorkerReleaseGuards, installPublicRunnerEpochGuards, installPublicRunnerCallbackEpochGuard, installReleaseRuntimeGuards };
