const { InboundWebhookService } = require('./inbound-webhook');
const { installInboundEventHardening } = require('./inbound-event-hardening');

installInboundEventHardening({ InboundWebhookService });
