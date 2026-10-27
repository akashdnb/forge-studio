const { SafeSearchIndexConsistencyService } = require('./index-consistency-safe');

function wrapPool(pool) {
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target);
      return (config, ...rest) => {
        if (config && typeof config === 'object' && typeof config.text === 'string' && config.text.includes('forge_search_source_project_id($1,$2)') && Array.isArray(config.values)) {
          config = { ...config, values: [JSON.stringify(config.values[0]), ...config.values.slice(1)] };
        }
        return target.query(config, ...rest);
      };
    },
  });
}

class JsonSafeSearchIndexConsistencyService extends SafeSearchIndexConsistencyService {
  constructor(options) { super({ ...options, pool: wrapPool(options.pool) }); }
}

module.exports = { JsonSafeSearchIndexConsistencyService };
