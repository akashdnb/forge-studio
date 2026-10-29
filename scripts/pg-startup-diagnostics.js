const { Client } = require('pg');

const originalQuery = Client.prototype.query;

function logQueryFailure(error, queryText) {
  console.error(`PG_QUERY_FAILURE code=${error.code || 'unknown'} message=${error.message}`);
  if (queryText) console.error(`PG_QUERY_SQL=${queryText.replace(/\s+/g, ' ').trim().slice(0, 4000)}`);
  if (error.position) {
    const position = Number(error.position);
    console.error(`PG_QUERY_POSITION=${position}`);
    if (Number.isFinite(position) && queryText) {
      console.error(`PG_QUERY_CONTEXT=${queryText.slice(Math.max(0, position - 500), position + 500).replace(/\s+/g, ' ').trim()}`);
    }
  }
}

Client.prototype.query = function patchedQuery(...args) {
  const config = args[0];
  const queryText = typeof config === 'string' ? config : config?.text;
  const result = originalQuery.apply(this, args);

  if (result && typeof result.once === 'function') {
    result.once('error', (error) => logQueryFailure(error, queryText));
  }

  if (result && typeof result.catch === 'function') {
    result.catch((error) => logQueryFailure(error, queryText));
  }

  return result;
};
