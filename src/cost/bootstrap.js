'use strict';
require('../usage/billing-worker-hook');
require('../usage/billing-operator-bootstrap');
require('../storage/artifact-lifecycle-bootstrap');
const { UsageAccountingService } = require('../usage/usage-accounting');
const { WorkflowScheduler } = require('../scheduling/workflow-scheduler');
const { CostGovernanceService, CostBudgetRejectedError } = require('./cost-governance');
require('./config-sync');
require('./budget-config');
const { handleCostRequest } = require('./http');
const { hasRole } = require('../security/http-security');
const accountingServices = new WeakMap();
const costForAccounting = (instance) => { let service = accountingServices.get(instance); if (!service) { service = new CostGovernanceService({ pool: instance.pool }); accountingServices.set(instance, service); } return service; };
if (!UsageAccountingService.prototype.__forgeCostGovernancePatched) {
  const originalSync = UsageAccountingService.prototype.syncConfiguration;
  UsageAccountingService.prototype.syncConfiguration = async function syncCostConfiguration(options = {}) { const service = costForAccounting(this); const result = await service.syncConfiguration(options); try { await originalSync.call(this, options); } catch (error) { if (this.required) throw error; } return result; };
  UsageAccountingService.prototype.reserveForJob = function reserveForJob(args) { return costForAccounting(this).reserveForJob(args); };
  UsageAccountingService.prototype.settleJob = function settleJob(args) { return costForAccounting(this).settleJob(args); };
  UsageAccountingService.prototype.recordRejection = function recordRejection(args) { return costForAccounting(this).recordRejection(args); };
  UsageAccountingService.prototype.recoverStaleReservations = function recoverStaleReservations(args) { return costForAccounting(this).recoverStaleReservations(args); };
  UsageAccountingService.prototype.__forgeCostGovernancePatched = true;
}
if (!WorkflowScheduler.prototype.__forgeCostGovernancePatched) {
  const originalClaimNext = WorkflowScheduler.prototype.claimNext;
  WorkflowScheduler.prototype.claimNext = async function claimNextWithCostAdmission(args = {}) {
    const job = await originalClaimNext.call(this, args);
    if (!job || process.env.FORGE_COST_ENFORCEMENT_ENABLED !== 'true') return job;
    const cost = new CostGovernanceService({ pool: this.pool });
    try {
      const admission = await cost.reserveForJob({ job, priority: Number(job.priority || 100) });
      if (admission.allowed) return job;
      await this.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,timeout_at=NULL,dispatch_token=NULL,available_at=GREATEST(available_at,now()+interval '1 second'),last_schedule_reason=$2,updated_at=now() WHERE id=$1 AND status='RUNNING'`, [job.id, `cost:${admission.reason || 'rejected'}`]);
      await this.releaseCapacityForJob(job.id, 'COST_REJECTED').catch(() => {}); return null;
    } catch (error) {
      await cost.recordRejection({ job, reason: error }).catch(() => {});
      await this.pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,timeout_at=NULL,dispatch_token=NULL,available_at=GREATEST(available_at,now()+interval '1 second'),last_schedule_reason=$2,updated_at=now() WHERE id=$1 AND status='RUNNING'`, [job.id, `cost:${error.code || 'rejected'}`]).catch(() => {});
      await this.releaseCapacityForJob(job.id, 'COST_REJECTED').catch(() => {});
      if (error instanceof CostBudgetRejectedError || error.code === 'COST_BUDGET_REJECTED') return null;
      throw error;
    }
  };
  WorkflowScheduler.prototype.__forgeCostGovernancePatched = true;
}
try {
  const extended = require('../extended-http-api');
  if (!extended.createExtendedApiServer.__forgeCostGovernancePatched) {
    const originalCreate = extended.createExtendedApiServer;
    extended.createExtendedApiServer = function createExtendedApiServerWithCost(options = {}) {
      const result = originalCreate(options); if (!result?.server || !options.repository) return result;
      const baseHandler = result.server.listeners('request')[0]; result.server.removeAllListeners('request');
      result.server.on('request', async (req, res) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (pathname.startsWith('/v1/cost/')) {
          const auth = req._auth;
          if (!auth || !hasRole(auth, 'OWNER')) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: { code: 'FORBIDDEN' } })); }
          const handled = await handleCostRequest(req, res, { pool: options.repository.db.pool, auth }); if (handled !== false) return;
        }
        return baseHandler(req, res);
      });
      return result;
    };
    extended.createExtendedApiServer.__forgeCostGovernancePatched = true;
  }
} catch (error) { if (process.env.FORGE_COST_ENFORCEMENT_ENABLED === 'true') throw error; }
module.exports = { CostGovernanceService };
