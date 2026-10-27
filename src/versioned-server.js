const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');

installHttpVersioning();
require('./server');
