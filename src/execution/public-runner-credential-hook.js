'use strict';

const crypto = require('node:crypto');
const { SecretCipher } = require('../runtime/runtime-policy');
const { CredentialAccessService, hash } = require('../providers/credential-access-service');
const { signManifest, canonicalJson, validateCredentialReference } = require('./public-runner-security');

const installed = Symbol.for('forge.public.runner.credential.hook');
const SENSITIVE = /(token|secret|password|authorization|api[_-]?key|private[_-]?key|material|ciphertext)/i;

function install() {
  try {
    const { PublicGithubActionsExecutionBackend } = require('./public-github-actions-backend');
    if (PublicGithubActionsExecutionBackend.prototype[installed]) return;
    const originalDispatchClaimed = PublicGithubActionsExecutionBackend.prototype.dispatchClaimed;
    PublicGithubActionsExecutionBackend.prototype.dispatchClaimed = async function credentialBoundDispatch({ job }) {
      const requested = job?.payload?.publicRunner?.credentialAccess;
      if (!requested) return originalDispatchClaimed.call(this, { job });
      if (!this.pool || !process.env.FORGE_SECRET_ENCRYPTION_KEY || !process.env.FORGE_CREDENTIAL_GRANT_SIGNING_SECRET || !process.env.FORGE_REGION) throw Object.assign(new Error('Public runner credential boundary is not configured'), { code:'CREDENTIAL_ACCESS_NOT_CONFIGURED', retryable:false });
      for (const key of Object.keys(requested)) if (SENSITIVE.test(key)) throw Object.assign(new Error('Public runner credential request contains secret material'), { code:'CREDENTIAL_REFERENCE_SECRET', retryable:false });
      const access = new CredentialAccessService({ pool:this.pool, secretCipher:new SecretCipher(process.env.FORGE_SECRET_ENCRYPTION_KEY) });
      const originalClientDispatch = this.client.dispatch.bind(this.client);
      this.client.dispatch = async manifest => {
        const execution = await this.getExecution(job.id, Number(job.attempts));
        const grant = await access.acquire({ tenantId:job.tenant_id || job.payload?.tenantId, projectId:job.project_id || job.payload?.projectId || null, purpose:String(requested.purpose || `runner:${job.kind}`), provider:String(requested.provider), model:String(requested.model || ''), capability:String(requested.capability || ''), operation:String(requested.operation || 'package'), workflowId:job.workflow_id || job.payload?.workflowId || null, jobId:job.id, attemptId:execution?.attempt_id || `public:${job.id}:${job.attempts}`, region:process.env.FORGE_REGION, executionEpoch:process.env.FORGE_RELEASE_EPOCH || process.env.FORGE_RELEASE_ID });
        manifest.credentialAccess = { grant:grant.grant, grantId:grant.grantId, provider:grant.provider, purpose:String(requested.purpose || `runner:${job.kind}`), region:process.env.FORGE_REGION, executionEpoch:process.env.FORGE_RELEASE_EPOCH || process.env.FORGE_RELEASE_ID, expiresAt:grant.expiresAt, fencingToken:grant.fencingToken };
        validateCredentialReference({ grantId:grant.grantId, provider:grant.provider, purpose:manifest.credentialAccess.purpose, region:manifest.credentialAccess.region, executionEpoch:manifest.credentialAccess.executionEpoch, expiresAt:manifest.credentialAccess.expiresAt });
        manifest.payloadHash = crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex');
        manifest.signature = signManifest(manifest, this.publicConfig.secret);
        if (execution) await this.pool.query('UPDATE forge_execution_runs SET manifest_hash=$1,manifest_signature=$2,metadata=$3::jsonb,updated_at=now() WHERE id=$4', [manifest.payloadHash, manifest.signature, JSON.stringify({ ...(execution.metadata || {}), credentialGrantId:grant.grantId, credentialProvider:grant.provider, credentialPurpose:manifest.credentialAccess.purpose, credentialAccessBound:true }), execution.id]);
        return originalClientDispatch(manifest);
      };
      try { return await originalDispatchClaimed.call(this, { job }); } finally { this.client.dispatch = originalClientDispatch; }
    };
    PublicGithubActionsExecutionBackend.prototype[installed] = true;
  } catch (error) {
    if (process.env.FORGE_PUBLIC_RUNNER_ENABLED === 'true') throw error;
  }
}
install();
module.exports = { install };
