const Module = require('node:module');
const { handleRegionRequest } = require('./region-http-handler');

if (!global.__forgeRegionHttpHook) {
  const originalLoad = Module._load;
  Module._load = function forgeRegionModuleLoad(request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    if (!parent || !request.endsWith('extended-http-api')) return loaded;
    if (!loaded || loaded.__forgeRegionWrapped) return loaded;
    const originalCreate = loaded.createExtendedApiServer;
    if (typeof originalCreate !== 'function') return loaded;
    loaded.createExtendedApiServer = function wrappedCreateExtendedApiServer(options = {}) {
      const result = originalCreate.call(this, options);
      if (!result?.server || !options.repository?.db?.pool) return result;
      const listeners = result.server.listeners('request');
      const baseHandler = listeners[0];
      if (!baseHandler) return result;
      result.server.removeAllListeners('request');
      result.server.on('request', (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        if (pathname.startsWith('/internal/regions/')) return handleRegionRequest(request, response, { pool: options.repository.db.pool });
        return baseHandler(request, response);
      });
      return result;
    };
    loaded.__forgeRegionWrapped = true;
    return loaded;
  };
  global.__forgeRegionHttpHook = true;
}
