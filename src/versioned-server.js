const { installHttpVersioning } = require('./api/api-versioning');
const { installOperationsControlPlaneExtensions } = require('./operations/control-plane-extensions');
const { installOperationsControlPlane } = require('./operations/control-plane');

installHttpVersioning();
installOperationsControlPlaneExtensions();
installOperationsControlPlane();
require('./server');
