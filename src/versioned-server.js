const { installHttpVersioning } = require('./api/api-versioning');
const { installOperationsControlPlane } = require('./operations/control-plane');

installHttpVersioning();
installOperationsControlPlane();
require('./server');
