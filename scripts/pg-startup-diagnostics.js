const { Client } = require('pg');

const originalQuery = Client.prototype.query;

Client.prototype.query = function patchedQuery(...args) {
  const config = args[0];
  const queryText = typeof config === 'string' ? config : config?.text;
  const result = originalQuery.apply(this, args);

  if (result && typeof result.catch === 'function') {
    result.catch((error) => {
      console.error(`PG_QUERY_FAILURE code=${error.code || 'unknown'} message=${error.message}`);
      if (queryText) console.error(`PG_QUERY_SQL=${queryText.replace(/\s+/g, ' ').trim().slice(0, 4000)}`);
      if (error.position) console.error(`PG_QUERY_POSITION=${error.position}`);
    });
  }

  return result;
};
