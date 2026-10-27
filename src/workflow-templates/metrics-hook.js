'use strict';
const { WorkflowTemplateService }=require('./service');
const { getActiveObservability }=require('../observability');
let installed=false;
function installWorkflowTemplateMetrics(){if(installed)return;installed=true;const p=WorkflowTemplateService.prototype;for(const [method,event] of [['validate','validation'],['activate','activation'],['compilePlan','plan_compile'],['dispatchPlan','plan_dispatch']]){const original=p[method];p[method]=async function(...args){const obs=getActiveObservability(),started=process.hrtime.bigint();try{const r=await original.apply(this,args);obs?.metrics.inc(`forge_workflow_template_${event}_total`,{outcome:'success'});return r;}catch(error){obs?.metrics.inc(`forge_workflow_template_${event}_total`,{outcome:error.code||'error'});throw error;}finally{obs?.metrics.observe(`forge_workflow_template_${event}_duration_seconds`,{},Number(process.hrtime.bigint()-started)/1e9);}}}}
module.exports={installWorkflowTemplateMetrics};
