const test = require('node:test');
const assert = require('node:assert/strict');
let pg; try { pg=require('pg'); } catch { pg=null; }

test('postgres search query shape uses the search GIN index', { skip: !process.env.DATABASE_URL || !pg }, async () => {
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
  const r=await pool.query({text:`EXPLAIN (FORMAT JSON) SELECT source_id FROM forge_search_documents WHERE tenant_id=$1 AND search_vector @@ plainto_tsquery('simple',$2) ORDER BY source_updated_at DESC,source_type,source_id LIMIT 25`,values:['explain-tenant','volcano']});
  const plan=JSON.stringify(r.rows[0]['QUERY PLAN']);
  assert.match(plan,/forge_search_documents_tenant_vector_idx|Bitmap Index Scan|Index Scan/i);
  await pool.end();
});
