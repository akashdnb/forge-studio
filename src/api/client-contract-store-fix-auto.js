const http = require('node:http');
const state = http[Symbol.for('forge.clientContracts')];
if (state?.pool && state.store) {
  state.store.latest = async (apiVersion) => (await state.pool.query("SELECT * FROM forge_client_contract_revisions WHERE api_version=$1 AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1", [apiVersion])).rows[0] || null;
}
