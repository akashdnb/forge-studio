const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { fingerprint } = require('../src/api/contract-governance');

async function main() {
  const command = process.argv[2] || 'readiness';
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    if (command === 'readiness') {
      const [contracts, overdue, legacy] = await Promise.all([
        pool.query('SELECT count(*)::int AS count FROM forge_api_contracts'),
        pool.query("SELECT count(*)::int AS count FROM forge_api_contracts WHERE sunset_at IS NOT NULL AND sunset_at <= now() AND status NOT IN ('sunset','disabled')"),
        pool.query("SELECT coalesce(sum(request_count),0)::bigint AS count FROM forge_api_usage WHERE api_version='v1' AND bucket_start > now() - interval '30 days'"),
      ]);
      console.log(JSON.stringify({ ready: contracts.rows[0].count > 0 && overdue.rows[0].count === 0, contracts: contracts.rows[0].count, overdueSunsets: overdue.rows[0].count, legacyRequests30d: legacy.rows[0].count }, null, 2));
      return;
    }
    if (command === 'inventory') {
      const openapi = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts/openapi-v2.json'), 'utf8'));
      let count = 0;
      for (const [routePath, operationMap] of Object.entries(openapi.paths || {})) {
        for (const [method, operation] of Object.entries(operationMap)) {
          if (!['get','post','put','patch','delete','head','options'].includes(method)) continue;
          const route = `${method.toUpperCase()} ${routePath.replace(/^\/v\d+/, '')}`;
          const requestSchema = operation.requestBody?.content?.['application/json']?.schema || {};
          const responseSchema = Object.values(operation.responses || {})[0]?.content?.['application/json']?.schema || {};
          for (const version of ['v2']) {
            await pool.query(`INSERT INTO forge_api_contracts(route_identity,method,path_pattern,api_version,request_schema_fingerprint,response_schema_fingerprint,status,activated_at,compatibility_mode,migration_notes,request_schema,response_schema)
              VALUES($1,$2,$3,$4,$5,$6,'supported',now(),'additive','Seeded from checked-in OpenAPI contract',$7,$8)
              ON CONFLICT(route_identity,api_version) DO UPDATE SET method=EXCLUDED.method,path_pattern=EXCLUDED.path_pattern,request_schema_fingerprint=EXCLUDED.request_schema_fingerprint,response_schema_fingerprint=EXCLUDED.response_schema_fingerprint,request_schema=EXCLUDED.request_schema,response_schema=EXCLUDED.response_schema,updated_at=now()`,
              [route, method.toUpperCase(), routePath.replace(/^\/v\d+/, '') || '/', version, fingerprint(requestSchema), fingerprint(responseSchema), JSON.stringify(requestSchema), JSON.stringify(responseSchema)]);
            count += 1;
          }
        }
      }
      console.log(JSON.stringify({ seeded: count }, null, 2));
      return;
    }
    if (command === 'consumers') {
      const result = await pool.query('SELECT * FROM forge_api_consumers ORDER BY last_seen_at DESC LIMIT 500');
      console.log(JSON.stringify(result.rows, null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
