'use strict';
const extended=require('../extended-http-api');
require('./http').installWorkflowTemplateHttp(extended);
require('./approval-http').installWorkflowTemplateApprovalHttp(extended);
