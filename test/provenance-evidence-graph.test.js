const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, digest, nodeIdentity, edgeIdentity, snapshotIdentity } = require('../src/provenance/evidence-graph');

test('canonicalization and identities are deterministic', () => {
  assert.equal(JSON.stringify(canonicalize({ b: 2, a: { d: 4, c: 3 } })), JSON.stringify({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(digest({ z: 1, a: 2 }), digest({ a: 2, z: 1 }));
  assert.equal(nodeIdentity({ tenantId: 't', projectId: 'p', nodeType: 'artifact', sourceId: 'a', contentDigest: digest('x') }), nodeIdentity({ tenantId: 't', projectId: 'p', nodeType: 'artifact', sourceId: 'a', contentDigest: digest('x') }));
  assert.notEqual(edgeIdentity({ sourceNodeId: 'a'.repeat(64), relation: 'X', targetNodeId: 'b'.repeat(64), evidenceDigest: digest('1') }), edgeIdentity({ sourceNodeId: 'a'.repeat(64), relation: 'X', targetNodeId: 'b'.repeat(64), evidenceDigest: digest('2') }));
  assert.equal(snapshotIdentity({ tenantId: 't', projectId: 'p', episodeId: 'e', versionId: 'v', snapshotDigest: digest('g') }), snapshotIdentity({ tenantId: 't', projectId: 'p', episodeId: 'e', versionId: 'v', snapshotDigest: digest('g') }));
});

test('postgresql provenance integration', { skip: !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const { PostgresRepository } = require('../src/persistence/postgres-repository');
  const { ProvenanceEvidenceGraph } = require('../src/provenance/evidence-graph');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  try {
    const repo = new PostgresRepository({ pool });
    await repo.migrate();
    const graph = new ProvenanceEvidenceGraph({ pool });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenant = `prov-test-tenant-${suffix}`;
    const project = `prov-test-project-${suffix}`;
    const episode = `prov-test-episode-${suffix}`;
    const version = `prov-test-version-${suffix}`;
    const artifact = `prov-test-artifact-${suffix}`;
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'test')", [tenant, tenant]);
    await pool.query("INSERT INTO projects(id,tenant_id,name,created_by) VALUES($1,$2,$3,'test')", [project, tenant, project]);
    await pool.query("INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,'test','test')", [episode, project]);
    await pool.query("INSERT INTO version_records(id,episode_id,kind,created_by) VALUES($1,$2,'script','test')", [version, episode]);
    await pool.query("INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,created_by) VALUES($1,$2,'caption',$3,'{}'::jsonb,$4,'test')", [artifact, episode, version, digest('{}')]);
    await pool.query("INSERT INTO artifact_lifecycle_records(artifact_id,project_id,state) VALUES($1,$2,'RETAINED')", [artifact, project]);

    const results = await Promise.all(Array.from({ length: 8 }, () => graph.ensureArtifactChain({ artifactId: artifact, actor: 'test', reason: 'concurrency' })));
    assert.equal(new Set(results.map((r) => r.nodeId)).size, 1);
    const nodes = await pool.query('SELECT count(*)::int AS count FROM forge_evidence_nodes WHERE tenant_id=$1 AND project_id=$2', [tenant, project]);
    assert.ok(nodes.rows[0].count >= 3);

    const snapshotA = await graph.snapshot({ tenantId: tenant, projectId: project, episodeId: episode, createdBy: 'test' });
    const snapshotB = await graph.snapshot({ tenantId: tenant, projectId: project, episodeId: episode, createdBy: 'test' });
    assert.equal(snapshotA.snapshotDigest, snapshotB.snapshotDigest);
    assert.deepEqual(snapshotA.graph, snapshotB.graph);
    assert.equal((await graph.verifySnapshot({ snapshotId: snapshotA.snapshotId, tenantId: tenant, projectId: project })).valid, true);

    await assert.rejects(() => graph.recordNode({ tenantId, projectId, nodeType: 'artifact', sourceId: artifact, content: { versionId: 'conflicting-parent' } }), /immutable evidence node identity conflict/);
    await pool.query("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'test')", [`${tenant}-other`, `${tenant}-other`]);
    await assert.rejects(async () => {
      const foreign = await graph.recordNode({ tenantId: `${tenant}-other`, projectId, nodeType: 'version', sourceId: 'foreign', content: 'x' });
      const local = await graph.recordNode({ tenantId, projectId, nodeType: 'version', sourceId: 'local', content: 'x' });
      return graph.recordEdge({ tenantId, projectId, sourceNodeId: foreign.node_id, relation: 'CROSS_TENANT', targetNodeId: local.node_id });
    }, /cross-tenant or cross-project evidence edge rejected|evidence node tenant\/project scope mismatch|foreign key/);

    const report = await graph.reconcile({ tenantId, projectId, actor: 'test' });
    assert.equal(report.status, 'SUCCEEDED');
    assert.equal(report.reportHash.length, 64);
    assert.equal(report.issueCount, 0);
  } finally {
    await pool.end();
  }
});
