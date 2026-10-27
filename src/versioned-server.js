const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
require('./operations/control-plane');
const { installIncidentControlPlane } = require('./incidents/http-extension');
installIncidentControlPlane();

installHttpVersioning();
require('./server');
