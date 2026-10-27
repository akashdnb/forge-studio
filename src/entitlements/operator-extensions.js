'use strict';
const crypto=require('node:crypto');
const {TenantPlanEntitlements}=require('./tenant-plan-entitlements');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
if(!TenantPlanEntitlements.prototype.createPlanVersion){
 TenantPlanEntitlements.prototype.createPlanVersion=async function({planId,definition={},actor}){return this.tx(async c=>this.insertVersion(c,planId,definition,actor,hash(definition)))};
 TenantPlanEntitlements.prototype.listPlans=async function(){const r=await this.pool.query(`SELECT p.*,count(pv.id)::int version_count,max(pv.version)::int latest_version FROM forge_plans p LEFT JOIN forge_plan_versions pv ON pv.plan_id=p.id GROUP BY p.id ORDER BY p.slug`);return r.rows};
 TenantPlanEntitlements.prototype.planHistory=async function(planId){const r=await this.pool.query(`SELECT pv.*,jsonb_object_agg(e.capability,jsonb_build_object('enabled',e.enabled,'limit',e.limit_value,'unit',e.limit_unit,'overagePolicy',e.overage_policy,'graceLimit',e.grace_limit)) FILTER (WHERE e.capability IS NOT NULL) entitlements FROM forge_plan_versions pv LEFT JOIN forge_plan_entitlements e ON e.plan_version_id=pv.id WHERE pv.plan_id=$1 GROUP BY pv.id ORDER BY pv.version DESC`,[planId]);return r.rows};
 TenantPlanEntitlements.prototype.rollback=async function({tenantId,planVersionId,actor,reason='rollback'}){return this.assign({tenantId,planVersionId,actor,grandfatherExistingWork:true,reason:`ROLLBACK: ${reason}`})};
}
module.exports={TenantPlanEntitlements};
