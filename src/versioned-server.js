const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
const { installOperationsControlPlane } = require('./operations/control-plane');
installOperationsControlPlane();
const { installIncidentControlPlane } = require('./incidents/http-extension');
installIncidentControlPlane();
const { installIncidentEventSubscriptionBridge } = require('./incidents/event-subscription-bridge');
installIncidentEventSubscriptionBridge();

installHttpVersioning();
require('./server');
