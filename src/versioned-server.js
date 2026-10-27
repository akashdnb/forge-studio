const { installHttpVersioning } = require('./api/api-versioning');

installHttpVersioning();
require('./server');
