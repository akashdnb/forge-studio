const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
const { installOperationsControlPlane } = require('./operations/control-plane');
installOperationsControlPlane();
const { installIncidentControlPlane } = require('./incidents/http-extension');
installIncidentControlPlane();
const { installIncidentEventSubscriptionBridge } = require('./incidents/event-subscription-bridge');
installIncidentEventSubscriptionBridge();
const { installIncidentHealthEndpoint } = require('./incidents/health-extension');
installIncidentHealthEndpoint();

installHttpVersioning();
require('./server');
