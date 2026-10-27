'use strict';
const { CostGovernanceService, CostGovernanceError } = require('./cost-governance');
const { digest } = require('./cost-governance');
if (!CostGovernanceService.prototype.__forgeBudgetConfigPatched) {
  CostGovernanceService.prototype.configureBudget = async function configureBudget(args = {}) {
    const { scopeType, scopeId, periodKey = 'lifetime', periodStart = null, periodEnd = null, hardCostLimit = null, softCostLimit = null, hardUsageLimit = null, softUsageLimit = null, softPriorityFloor = 100, currency = 'USD', actor = 'operator', metadata = {}, configVersion = 'operator-v1' } = args;
    const allowed = new Set(['GLOBAL','TENANT','PROJECT','EPISODE','RUN','PROVIDER']); if (!allowed.has(scopeType)) throw new TypeError('invalid budget scope'); if (!scopeId || !actor) throw new TypeError('scopeId and actor are required');
    return this.tx(async (c) => {
      const lockKey = `cost-budget:${scopeType}:${scopeId}:${periodKey}:${String(currency).toUpperCase()}`;
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      if (scopeType === 'TENANT') { const r = await c.query('SELECT 1 FROM tenants WHERE id=$1', [scopeId]); if (!r.rows[0]) throw new CostGovernanceError('tenant not found', 'NOT_FOUND'); }
      if (scopeType === 'PROJECT') { const r = await c.query('SELECT tenant_id FROM projects WHERE id=$1', [scopeId]); if (!r.rows[0]) throw new CostGovernanceError('project not found', 'NOT_FOUND'); }
      if (scopeType === 'EPISODE') { const r = await c.query('SELECT 1 FROM episodes WHERE id=$1', [scopeId]); if (!r.rows[0]) throw new CostGovernanceError('episode not found', 'NOT_FOUND'); }
      const currencyCode = String(currency).toUpperCase();
      const next = Number((await c.query('SELECT COALESCE(MAX(epoch),0)+1 epoch FROM cost_budget_epochs WHERE scope_type=$1 AND scope_id=$2 AND period_key=$3 AND currency=$4', [scopeType, scopeId, periodKey, currencyCode])).rows[0].epoch);
      await c.query('UPDATE cost_budget_epochs SET active=false,retired_at=now() WHERE scope_type=$1 AND scope_id=$2 AND period_key=$3 AND currency=$4 AND active=true', [scopeType, scopeId, periodKey, currencyCode]);
      const row = (await c.query(`INSERT INTO cost_budget_epochs(scope_type,scope_id,epoch,period_key,period_start,period_end,hard_cost_limit,soft_cost_limit,hard_usage_limit,soft_usage_limit,soft_priority_floor,currency,config_version,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING *`, [scopeType, scopeId, next, periodKey, periodStart, periodEnd, hardCostLimit == null ? null : Number(hardCostLimit), softCostLimit == null ? null : Number(softCostLimit), hardUsageLimit == null ? null : Number(hardUsageLimit), softUsageLimit == null ? null : Number(softUsageLimit), Number(softPriorityFloor), currencyCode, configVersion, JSON.stringify(metadata || {}), actor])).rows[0];
      return row;
    });
  };
  CostGovernanceService.prototype.__forgeBudgetConfigPatched = true;
}
module.exports = { CostGovernanceService, digest };
