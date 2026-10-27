'use strict';
const { CostGovernanceService } = require('./cost-governance');
if (!CostGovernanceService.prototype.__forgeCostConfigSync) {
  CostGovernanceService.prototype.syncConfiguration = async function syncConfiguration({ pricing = [], budgets = [] } = {}) {
    const configuredPricing = pricing.length ? pricing : (process.env.FORGE_USAGE_PRICING_JSON ? JSON.parse(process.env.FORGE_USAGE_PRICING_JSON) : []);
    const configuredBudgets = budgets.length ? budgets : (process.env.FORGE_USAGE_BUDGETS_JSON ? JSON.parse(process.env.FORGE_USAGE_BUDGETS_JSON) : []);
    for (const p of configuredPricing) await this.configureRate({ providerType:p.providerType||'workflow',provider:p.provider||'',model:p.model||'',operation:p.operation,unitType:p.unitType||'request',unitPrice:p.unitPrice,currency:p.currency||'USD',normalizedCurrency:p.normalizedCurrency||p.currency||'USD',fxRateToNormalized:p.fxRateToNormalized??1,version:p.configVersion||p.version||'env-v1',actor:'configuration-sync' });
    for (const b of configuredBudgets) await this.configureBudget({ scopeType:b.scopeType,scopeId:b.scopeId,periodKey:b.periodKey||'lifetime',periodStart:b.periodStart||null,periodEnd:b.periodEnd||null,hardCostLimit:b.hardCostLimit??null,softCostLimit:b.softCostLimit??null,hardUsageLimit:b.hardUsageLimit??null,softUsageLimit:b.softUsageLimit??null,softPriorityFloor:b.softPriorityFloor??100,currency:b.currency||'USD',actor:'configuration-sync',metadata:b.metadata||{},configVersion:b.configVersion||'env-v1' });
    return {pricing:configuredPricing.length,budgets:configuredBudgets.length};
  };
  CostGovernanceService.prototype.__forgeCostConfigSync = true;
}
module.exports={CostGovernanceService};
