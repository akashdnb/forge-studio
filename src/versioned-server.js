const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
require('./diff/http');
installHttpVersioning();
require('./server');
