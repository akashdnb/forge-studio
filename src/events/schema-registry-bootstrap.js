'use strict';
const {EventSchemaRegistry}=require('./schema-registry');
const {DurableEventDelivery}=require('./durable-delivery');
const {TransactionalOutboxDelivery}=require('./transactional-outbox');
const {InboundWebhookService}=require('./inbound-webhook');

function registryFor(pool){return new EventSchemaRegistry({pool,logger:console})}
async function validateWithFallback(registry,args){try{return await registry.validate(args)}catch(e){if(e.code==='SCHEMA_NOT_FOUND'&&args.tenantId)return registry.validate({...args,tenantId:null});throw e}}
function patch(){
 if(DurableEventDelivery.prototype.__schemaRegistryPatched)return;
 const originalPublish=DurableEventDelivery.prototype.publish;
 DurableEventDelivery.prototype.publish=async function(args){const body={...args.payload};const legacy=require('./durable-delivery').EVENT_SCHEMAS[args.type];if(!legacy)throw Object.assign(new Error(`Unknown event type: ${args.type}`),{code:'SCHEMA_NOT_FOUND'});await validateWithFallback(this.registry||registryFor(this.pool),{eventFamily:args.type,version:legacy.version,payload:body,tenantId:args.tenantId,projectId:args.projectId,source:'producer',sourceId:args.aggregateId||null});return originalPublish.call(this,args)};
 const originalDeliver=DurableEventDelivery.prototype.deliver;
 DurableEventDelivery.prototype.deliver=async function(delivery){const registry=this.registry||registryFor(this.pool);await validateWithFallback(registry,{eventFamily:delivery.type,version:delivery.version,payload:delivery.payload,tenantId:delivery.tenant_id,projectId:delivery.project_id,source:'delivery',sourceId:delivery.event_id});return originalDeliver.call(this,delivery)};
 const originalOutboxPublish=TransactionalOutboxDelivery.prototype.publish;
 TransactionalOutboxDelivery.prototype.publish=async function(args){const legacy=require('./durable-delivery').EVENT_SCHEMAS[args.type];if(!legacy)throw Object.assign(new Error(`Unknown event type: ${args.type}`),{code:'SCHEMA_NOT_FOUND'});await validateWithFallback(registryFor(this.pool),{eventFamily:args.type,version:legacy.version,payload:{...args.payload},tenantId:args.tenantId,projectId:args.projectId,source:'transactional-outbox',sourceId:args.aggregateId||null});return originalOutboxPublish.call(this,args)};
 const originalInbound=InboundWebhookService.prototype.ingest;
 InboundWebhookService.prototype.ingest=async function(args){const payload=JSON.parse(args.body);await validateWithFallback(this.registry||registryFor(this.pool),{eventFamily:args.eventType,version:Number(args.version),payload,tenantId:(await this.pool.query('SELECT tenant_id FROM forge_inbound_webhook_endpoints WHERE id=$1 AND active',[args.endpointId])).rows[0]?.tenant_id||null,projectId:(await this.pool.query('SELECT project_id FROM forge_inbound_webhook_endpoints WHERE id=$1 AND active',[args.endpointId])).rows[0]?.project_id||null,source:'inbound-webhook',sourceId:args.externalEventId});return originalInbound.call(this,args)};
 DurableEventDelivery.prototype.__schemaRegistryPatched=true;
}
patch();
module.exports={patch,validateWithFallback};
