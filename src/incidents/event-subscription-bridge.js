'use strict';
const { DurableEventDelivery } = require('../events/durable-delivery');
const INCIDENT_EVENT_TYPES = new Set(['incident.created','incident.acknowledge','incident.assign','incident.suppress','incident.unsuppress','incident.resolve','incident.reopen','incident.escalate']);
function installIncidentEventSubscriptionBridge() {
  if (DurableEventDelivery.prototype.__forgeIncidentSubscriptionBridge) return;
  DurableEventDelivery.prototype.__forgeIncidentSubscriptionBridge = true;
  const original = DurableEventDelivery.prototype.createSubscription;
  DurableEventDelivery.prototype.createSubscription = async function createIncidentAwareSubscription(options) {
    const requested = Array.isArray(options?.eventTypes) ? options.eventTypes : [];
    const incidentTypes = requested.filter(type => INCIDENT_EVENT_TYPES.has(type));
    const normalTypes = requested.filter(type => !INCIDENT_EVENT_TYPES.has(type));
    const result = await original.call(this, { ...options, eventTypes: normalTypes });
    if (incidentTypes.length) {
      const eventTypes = [...new Set([...normalTypes, ...incidentTypes])];
      const updated = await this.pool.query('UPDATE forge_event_subscriptions SET event_types=$2::text[],updated_at=now() WHERE id=$1 AND tenant_id=$3 RETURNING id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,created_by,created_at,updated_at', [result.id, eventTypes, options.tenantId]);
      return updated.rows[0] || result;
    }
    return result;
  };
}
module.exports = { installIncidentEventSubscriptionBridge, INCIDENT_EVENT_TYPES };
