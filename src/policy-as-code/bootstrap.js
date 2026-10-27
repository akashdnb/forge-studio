'use strict';

const { PolicyEngine } = require('./policy-engine');

const ENGINE_KEY = Symbol.for('forge.policy.engine');
function getPolicyEngine(pool) {
  if (!pool) throw new TypeError('policy engine requires a pg pool');
  if (!globalThis[ENGINE_KEY] || globalThis[ENGINE_KEY].pool !== pool) globalThis[ENGINE_KEY] = { pool, engine: new PolicyEngine({ pool }) };
  return globalThis[ENGINE_KEY].engine;
}
async function enforcePolicy({ pool, tenantId, subject, resource, action, attributes = {}, explain = false }) {
  return getPolicyEngine(pool).evaluate({ tenantId, subject, resource, action, attributes, explain });
}
function deny(error, result) { throw Object.assign(new Error(result?.reason || 'Policy denied operation'), { code: 'POLICY_DENIED', statusCode: 403, policyDecisionId: result?.decisionId, policySignature: result?.signature, policyEvidence: result?.evidence, cause: error }); }

function installRuntimeBoundaries() {
  if (globalThis[Symbol.for('forge.policy.boundaries.installed')]) return;
  globalThis[Symbol.for('forge.policy.boundaries.installed')] = true;
  try {
    const { JobQueue } = require('../persistence/job-queue');
    const claim = JobQueue.prototype.claim;
    JobQueue.prototype.claim = async function policyClaim(options = {}) {
      const job = await claim.call(this, options); if (!job) return job;
      if (!job.tenant_id) return job;
      try {
        const result = await enforcePolicy({ pool: this.pool, tenantId: job.tenant_id, subject: { type: 'worker', id: options.workerId, tenantId: job.tenant_id }, resource: { type: 'job', id: job.id, tenantId: job.tenant_id, projectId: job.project_id }, action: `runner.${job.kind}` });
        if (result.decision !== 'ALLOW') { await this.cancel(job.id, options.workerId, `Policy denied ${job.kind}`); return null; }
        return job;
      } catch (error) { if (error.code === 'POLICY_DENIED') { await this.cancel(job.id, options.workerId, error.message).catch(() => {}); return null; } throw error; }
    };
    const claimSpecific = JobQueue.prototype.claimSpecific;
    JobQueue.prototype.claimSpecific = async function policyClaimSpecific(id, workerId, now) {
      const job = await claimSpecific.call(this, id, workerId, now); if (!job?.tenant_id) return job;
      try { const result = await enforcePolicy({ pool: this.pool, tenantId: job.tenant_id, subject: { type: 'worker', id: workerId, tenantId: job.tenant_id }, resource: { type: 'job', id: job.id, tenantId: job.tenant_id, projectId: job.project_id }, action: `runner.${job.kind}` }); if (result.decision !== 'ALLOW') { await this.cancel(job.id, workerId, `Policy denied ${job.kind}`); return null; } return job; } catch (error) { await this.cancel(job.id, workerId, error.message).catch(() => {}); throw error; }
    };
  } catch {}
  try {
    const { ProductionArtifactAccessGateway } = require('../storage/production-artifact-access-gateway');
    const authorize = ProductionArtifactAccessGateway.prototype._authorize;
    ProductionArtifactAccessGateway.prototype._authorize = async function policyAuthorize(artifactId, options = {}) {
      const artifact = await this._loadArtifact(artifactId); if (!artifact) return authorize.call(this, artifactId, options);
      const action = options.action === 'metadata' ? 'artifact.read' : options.action === 'stream' ? 'artifact.stream' : 'artifact.download';
      const result = await enforcePolicy({ pool: this.repository.db.pool, tenantId: artifact.tenant_id || options.tenantId, subject: { type: options.actor && this.workerActors?.has(options.actor) ? 'worker' : 'user', id: options.actor, tenantId: options.tenantId || artifact.tenant_id }, resource: { type: 'artifact', id: artifact.id, tenantId: artifact.tenant_id || options.tenantId, projectId: artifact.project_id }, action, attributes: { purpose: options.purpose || 'user', recovery: Boolean(options.recovery) } });
      if (result.decision !== 'ALLOW') deny(null, result);
      return authorize.call(this, artifactId, options);
    };
  } catch {}
  try {
    const { PublishService } = require('../publishing/publish-service');
    const ensureRequest = PublishService.prototype.ensureRequest;
    PublishService.prototype.ensureRequest = async function policyPublish(run, actor = 'worker') {
      const result = await enforcePolicy({ pool: this.pool, tenantId: run.tenant_id, subject: { type: actor === 'worker' ? 'worker' : 'operator', id: actor, tenantId: run.tenant_id }, resource: { type: 'release', id: run.id, tenantId: run.tenant_id, projectId: run.project_id }, action: 'release.publish', attributes: { destination: run.destination, episodeId: run.episode_id, releaseEpoch: run.release_epoch } });
      if (result.decision !== 'ALLOW') deny(null, result);
      return ensureRequest.call(this, run, actor);
    };
  } catch {}
  try {
    const { ProviderAdmission } = require('../admission/provider-admission');
    const acquire = ProviderAdmission.prototype.acquire;
    ProviderAdmission.prototype.acquire = async function policyProviderAcquire(input = {}) {
      const scope = await this.scope(input.context || {});
      const subject = { type: input.context?.subjectType || (input.context?.workerId ? 'worker' : 'service'), id: input.context?.actor || input.context?.workerId || 'runtime', tenantId: scope.tenantId };
      const result = await enforcePolicy({ pool: this.pool, tenantId: scope.tenantId, subject, resource: { type: 'provider', id: input.provider, tenantId: scope.tenantId, projectId: scope.projectId }, action: `provider.${input.operation || 'execute'}`, attributes: { model: input.model || '', attempt: input.attempt || 1 } });
      if (result.decision !== 'ALLOW') deny(null, result);
      return acquire.call(this, input);
    };
  } catch {}
}

async function parseBody(request) {
  let body = ''; for await (const chunk of request) body += chunk; if (!body) return {}; try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON', statusCode: 400 }); }
}
function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }

async function handlePolicyRequest(request, response, { pool, auth, hasRole }) {
  const url = new URL(request.url || '/', 'http://localhost'); if (!url.pathname.startsWith('/internal/policy')) return false;
  if (!auth || !hasRole(auth, 'OWNER') && !hasRole(auth, 'ADMIN') && !hasRole(auth, 'OPERATOR')) return json(response, 403, { error: 'FORBIDDEN' });
  const engine = getPolicyEngine(pool); const actor = auth.actor; const tenantId = auth.tenantId;
  try {
    if (request.method === 'POST' && url.pathname === '/internal/policies/validate') return json(response, 200, await engine.validate((await parseBody(request)).document));
    if (request.method === 'POST' && url.pathname === '/internal/policies') { const body=await parseBody(request); return json(response,201,await engine.createPolicy({tenantId,name:body.name,document:body.document,actor})); }
    const versionMatch=url.pathname.match(/^\/internal\/policies\/([^/]+)\/versions$/); if(request.method==='POST'&&versionMatch){const body=await parseBody(request);return json(response,201,await engine.createVersion({tenantId,policyId:versionMatch[1],expectedVersion:body.expectedVersion,document:body.document,actor}));}
    if(request.method==='POST'&&url.pathname==='/internal/policy-bundles'){const body=await parseBody(request);const id=body.id||`bundle:${require('node:crypto').randomUUID()}`;await pool.query(`INSERT INTO forge_policy_bundles(id,tenant_id,name,priority,state,current_epoch,active_versions,rollout_percent,created_by) VALUES($1,$2,$3,$4,'ACTIVE',0,'[]'::jsonb,100,$5)`,[id,tenantId,body.name,Number(body.priority||100),actor]);return json(response,201,{id});}
    const activate=url.pathname.match(/^\/internal\/policy-bundles\/([^/]+)\/activate$/); if(request.method==='POST'&&activate){const body=await parseBody(request);return json(response,200,await engine.activateBundle({tenantId,bundleId:activate[1],expectedEpoch:body.expectedEpoch,versions:body.versions,rolloutPercent:body.rolloutPercent??100,rollbackToEpoch:body.rollbackToEpoch||null,actor}));}
    if(request.method==='POST'&&url.pathname==='/internal/policy-emergency-deny'){const body=await parseBody(request);return json(response,201,await engine.emergencyDeny({tenantId,action:body.action,resourceType:body.resourceType,reason:body.reason,expiresAt:body.expiresAt,actor}));}
    if(request.method==='POST'&&url.pathname==='/internal/policies/explain'){const body=await parseBody(request);return json(response,200,await engine.evaluate({...body,tenantId,explain:true}));}
    if(request.method==='GET'&&url.pathname==='/internal/policy-decisions')return json(response,200,{decisions:await engine.listDecisions({tenantId,limit:url.searchParams.get('limit')||50})});
    return json(response,404,{error:'NOT_FOUND'});
  } catch(error) { return json(response,error.statusCode||500,{error:error.code||'POLICY_ERROR',message:error.message}); }
}

installRuntimeBoundaries();
module.exports={getPolicyEngine,enforcePolicy,handlePolicyRequest,installRuntimeBoundaries};
