const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
const { installOperationsControlPlane } = require('./operations/control-plane');
installOperationsControlPlane();
const { installIncidentControlPlane } = require('./incidents/http-extension');
installIncidentControlPlane();

installHttpVersioning();
require('./server');
