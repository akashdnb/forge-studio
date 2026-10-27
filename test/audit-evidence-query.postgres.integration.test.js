const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AuditEvidenceQueryService, sha256 } = require('../src/evidence/audit-evidence-query');

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
let pool;

async function migrate() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await pool.query(await fs.readFile(path.join(__dirname, '..', 'migrations', '154_audit_evidence_query_integrity_retention.sql'), 'utf8'));
}

async function appendEvent({ tenantId, projectId, actor, occurredAt, corrupt = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const head = (await client.query('SELECT chain_head_seq,chain_head_hash FROM forge_evidence_chain_state WHERE id=1 FOR UPDATE')).rows[0];
    const seq = Number((await client.query("SELECT nextval('forge_evidence_ledger_seq') AS seq")).rows[0].seq);
    const eventId = sha256(`${tenantId}|${seq}|${projectId}`);
    const payloadDigest = sha256(JSON.stringify({ tenantId, projectId, seq }));
    const prevHash = head.chain_head_hash;
    const expected = sha256([seq,eventId,prevHash,tenantId,projectId,'episode-1',actor,'test_events','INSERT','target-1','req-1','',payloadDigest].join('|'));
    const eventHash = corrupt ? 'f'.repeat(64) : expected;
    await client.query(`INSERT INTO evidence_ledger(ledger_seq,event_id,tenant_id,project_id,episode_id,actor,event_type,source_table,operation,target_type,target_id,request_id,occurred_at,payload_digest,prev_hash,event_hash)
      VALUES($1,$2,$3,$4,'episode-1',$5,'TEST','test_events','INSERT','test_events','target-1','req-1',$6,$7,$8,$9)`, [seq,eventId,tenantId,projectId,actor,occurredAt,payloadDigest,prevHash,eventHash]);
    await client.query('UPDATE forge_evidence_chain_state SET chain_head_seq=$1,chain_head_hash=$2,updated_at=now() WHERE id=1', [seq,eventHash]);
    await client.query('COMMIT');
    return { seq, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('audit evidence query migration is ordered after existing audit integrity and is idempotent', { skip }, async () => {
  await migrate();
  await migrate();
  const files = (await fs.readdir(path.join(__dirname, '..', 'migrations'))).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  assert.ok(files.indexOf('154_audit_evidence_query_integrity_retention.sql') > files.indexOf('153_tenant_plan_entitlements.sql'));
  const tables = await pool.query("SELECT to_regclass('evidence_search_index') AS search_index, to_regclass('evidence_integrity_runs') AS integrity_runs, to_regclass('evidence_export_audit') AS export_audit");
  assert.equal(tables.rows[0].search_index, 'evidence_search_index');
  assert.equal(tables.rows[0].integrity_runs, 'evidence_integrity_runs');
  assert.equal(tables.rows[0].export_audit, 'evidence_export_audit');
});

test('concurrent writers preserve a single global chain and tenant-isolated indexed search', { skip }, async () => {
  await migrate();
  const tenantA = `audit-a-${Date.now()}-${Math.random()}`;
  const tenantB = `audit-b-${Date.now()}-${Math.random()}`;
  const project = `project-${Date.now()}`;
  const [a, b] = await Promise.all([
    appendEvent({ tenantId: tenantA, projectId: project, actor: 'actor-a', occurredAt: new Date(Date.now() - 2000).toISOString() }),
    appendEvent({ tenantId: tenantB, projectId: project, actor: 'actor-b', occurredAt: new Date(Date.now() - 1000).toISOString() }),
  ]);
  const service = new AuditEvidenceQueryService({ pool });
  const first = await service.search({ tenantId: tenantA, limit: 10 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].tenant_id, tenantA);
  assert.notEqual(first.items[0].event_id, b.eventId);
  const plan = await pool.query(`EXPLAIN SELECT event_id FROM evidence_search_index WHERE tenant_id=$1 AND occurred_at >= now()-interval '1 day' ORDER BY occurred_at DESC, ledger_seq DESC LIMIT 20`, [tenantA]);
  assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /(Index Scan|Bitmap Index Scan)/);
  assert.ok(a.seq !== b.seq);
});

test('deterministic cursor pagination does not duplicate or skip rows', { skip }, async () => {
  await migrate();
  const tenant = `cursor-${Date.now()}-${Math.random()}`;
  const project = `cursor-project-${Date.now()}`;
  for (let i = 0; i < 4; i += 1) await appendEvent({ tenantId: tenant, projectId: project, actor: `actor-${i}`, occurredAt: new Date(Date.now() + i).toISOString() });
  const service = new AuditEvidenceQueryService({ pool });
  const seen = [];
  let cursor = null;
  do {
    const page = await service.search({ tenantId: tenant, limit: 2, cursor });
    seen.push(...page.items.map((item) => item.event_id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
});

test('tampered hash is detected and evidence index remains append-only', { skip }, async () => {
  await migrate();
  const tenant = `tamper-${Date.now()}-${Math.random()}`;
  await appendEvent({ tenantId: tenant, projectId: `tamper-project-${Date.now()}`, actor: 'tamper-test', occurredAt: new Date().toISOString(), corrupt: true });
  const service = new AuditEvidenceQueryService({ pool });
  const result = await service.verify({ tenantId: tenant, fullChain: true, maxEvents: 1000 });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'CHAIN_HASH_MISMATCH'));
  const event = (await pool.query('SELECT event_id FROM evidence_search_index WHERE tenant_id=$1', [tenant])).rows[0];
  await assert.rejects(() => pool.query('UPDATE evidence_search_index SET actor=\'attacker\' WHERE event_id=$1', [event.event_id]), /evidence search index is immutable/);
});

test.after(async () => { if (pool) await pool.end(); });
