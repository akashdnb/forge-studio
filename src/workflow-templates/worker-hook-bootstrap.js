'use strict';
const { installWorkflowTemplateWorkerHooks }=require('./worker-hooks');
const { installWorkflowTemplateMetrics }=require('./metrics-hook');
installWorkflowTemplateWorkerHooks();
installWorkflowTemplateMetrics();