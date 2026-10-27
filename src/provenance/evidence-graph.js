const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((out, key) => { out[key] = canonicalize(value[key]); return out; }, {});
}
function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonicalize(value))).digest('hex');
}
function nodeIdentity({ tenantId, projectId, nodeType, sourceId, contentDigest }) {
  return digest(`forge-evidence-node:v1|${tenantId}|${projectId}|${nodeType}|${sourceId}|${contentDigest}`);
}
function edgeIdentity({ sourceNodeId, relation, targetNodeId, evidenceDigest }) {
  return digest(`forge-evidence-edge:v1|${sourceNodeId}|${relation}|${targetNodeId}|${evidenceDigest}`);
}
function snapshotIdentity({ tenantId, projectId, episodeId = '', versionId = '', snapshotDigest }) {
  return digest(`forge-evidence-snapshot:v1|${tenantId}|${projectId}|${episodeId}|${versionId}|${snapshotDigest}`);
}

class ProvenanceEvidenceGraph {
  constructor({ pool, observability = null }) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    this.pool = pool;
    this.observability = observability;
  }

  async withTransaction(fn) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async recordNode({ tenantId, projectId, nodeType, sourceId, content, lifecycleState = 'ACTIVE', payload = {} }, client = this.pool) {
    if (!tenantId || !projectId || !nodeType || !sourceId) throw new TypeError('tenantId, projectId, nodeType and sourceId are required');
    const contentDigest = digest(content);
    const nodeId = nodeIdentity({ tenantId, projectId, nodeType, sourceId, contentDigest });
    const inserted = await client.query(`INSERT INTO forge_evidence_nodes(node_id,tenant_id,project_id,node_type,source_id,content_digest,lifecycle_state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING *`, [nodeId, tenantId, projectId, nodeType, sourceId, contentDigest, lifecycleState, JSON.stringify(canonicalize(payload))]);
    if (inserted.rows[0]) {
      this.observability?.metrics?.inc('forge_evidence_nodes_total', { outcome: 'created', node_type: nodeType });
      return inserted.rows[0];
    }
    const existing = await client.query('SELECT * FROM forge_evidence_nodes WHERE tenant_id=$1 AND project_id=$2 AND node_type=$3 AND source_id=$4 FOR SHARE', [tenantId, projectId, nodeType, sourceId]);
    const row = existing.rows[0];
    if (!row || row.content_digest !== contentDigest || row.node_id !== nodeId) throw Object.assign(new Error('immutable evidence node identity conflict'), { code: 'EVIDENCE_CONFLICT' });
    this.observability?.metrics?.inc('forge_evidence_nodes_total', { outcome: 'deduplicated', node_type: nodeType });
    return row;
  }

  async recordEdge({ tenantId, projectId, sourceNodeId, relation, targetNodeId, evidence = {} }, client = this.pool) {
    if (!sourceNodeId || !targetNodeId || !relation) throw new TypeError('sourceNodeId, relation and targetNodeId are required');
    const evidenceDigest = digest(evidence);
    const edgeId = edgeIdentity({ sourceNodeId, relation, targetNodeId, evidenceDigest });
    const inserted = await client.query(`INSERT INTO forge_evidence_edges(edge_id,tenant_id,project_id,source_node_id,relation,target_node_id,evidence_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING *`, [edgeId, tenantId, projectId, sourceNodeId, relation, targetNodeId, evidenceDigest, JSON.stringify(canonicalize(evidence))]);
    if (inserted.rows[0]) {
      this.observability?.metrics?.inc('forge_evidence_edges_total', { relation });
      return inserted.rows[0];
    }
    const existing = await client.query('SELECT * FROM forge_evidence_edges WHERE edge_id=$1 FOR SHARE', [edgeId]);
    if (!existing.rows[0]) throw Object.assign(new Error('evidence edge disappeared during concurrent write'), { code: 'EVIDENCE_RACE' });
    return existing.rows[0];
  }

  async ensureArtifactChain({ artifactId, actor = 'system', reason = 'artifact-gateway' }) {
    return this.withTransaction(async (client) => {
      const artifact = (await client.query(`SELECT a.*,e.project_id,p.tenant_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1 FOR SHARE`, [artifactId])).rows[0];
      if (!artifact) throw Object.assign(new Error('artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
      await client.query(`INSERT INTO artifact_lifecycle_records(artifact_id,project_id,state) VALUES($1,$2,'RETAINED') ON CONFLICT (artifact_id) DO NOTHING`, [artifactId, artifact.project_id]);
      const lifecycle = (await client.query('SELECT state FROM artifact_lifecycle_records WHERE artifact_id=$1 FOR SHARE', [artifactId])).rows[0];
      const scope = { tenantId: artifact.tenant_id, projectId: artifact.project_id };
      const episodeId = artifact.episode_id;
      const nodePayload = (extra = {}) => ({ episodeId, ...extra });
      const artifactNode = await this.recordNode({ ...scope, nodeType: 'artifact', sourceId: artifact.id, content: { kind: artifact.kind, versionId: artifact.version_id, contentHash: artifact.content_hash, storageUri: artifact.storage_uri, inputVersionIds: artifact.input_version_ids, providerRunId: artifact.provider_run_id }, lifecycleState: lifecycle.state, payload: nodePayload({ actor, reason }) }, client);
      const episode = (await client.query('SELECT * FROM episodes WHERE id=$1', [episodeId])).rows[0];
      const version = (await client.query('SELECT * FROM version_records WHERE id=$1 AND episode_id=$2', [artifact.version_id, episodeId])).rows[0];
      if (!episode || !version) throw Object.assign(new Error('artifact lineage references missing episode/version'), { code: 'BROKEN_LINEAGE' });
      const episodeNode = await this.recordNode({ ...scope, nodeType: 'episode', sourceId: episodeId, content: episode, payload: nodePayload({ evidence: 'episode-owner' }) }, client);
      const versionNode = await this.recordNode({ ...scope, nodeType: 'version', sourceId: artifact.version_id, content: version, payload: nodePayload({ evidence: 'artifact-version' }) }, client);
      await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'BELONGS_TO_EPISODE', targetNodeId: episodeNode.node_id }, client);
      await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'DERIVED_FROM_VERSION', targetNodeId: versionNode.node_id }, client);
      for (const inputVersionId of Array.isArray(artifact.input_version_ids) ? artifact.input_version_ids : []) {
        const input = (await client.query('SELECT v.*,e.project_id,p.tenant_id FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE v.id=$1', [inputVersionId])).rows[0];
        if (!input || input.episode_id !== episodeId || input.project_id !== scope.projectId || input.tenant_id !== scope.tenantId) throw Object.assign(new Error('cross-tenant/episode/project input version rejected'), { code: 'BROKEN_LINEAGE' });
        const inputNode = await this.recordNode({ ...scope, nodeType: 'version', sourceId: inputVersionId, content: input, payload: nodePayload({ evidence: 'artifact-input' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'CONSUMED_INPUT', targetNodeId: inputNode.node_id }, client);
      }
      if (artifact.provider_run_id) {
        const run = (await client.query('SELECT * FROM provider_runs WHERE id=$1 AND episode_id=$2', [artifact.provider_run_id, episodeId])).rows[0];
        if (!run) throw Object.assign(new Error('provider run is missing or cross-episode'), { code: 'BROKEN_PROVIDER_LINEAGE' });
        const runNode = await this.recordNode({ ...scope, nodeType: 'provider-run', sourceId: run.id, content: run, payload: nodePayload({ evidence: 'provider-execution', workerIdentity: run.external_job_id || null }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'PRODUCED_BY_PROVIDER_RUN', targetNodeId: runNode.node_id }, client);
      }
      const storage = (await client.query('SELECT * FROM storage_objects WHERE artifact_id=$1 ORDER BY created_at DESC LIMIT 1', [artifactId])).rows[0];
      if (storage) {
        const storageNode = await this.recordNode({ ...scope, nodeType: 'storage-object', sourceId: storage.id, content: storage, lifecycleState: storage.status || lifecycle.state, payload: nodePayload({ evidence: 'artifact-storage' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'STORED_AS', targetNodeId: storageNode.node_id }, client);
      }
      const jobs = await client.query(`SELECT * FROM forge_jobs WHERE episode_id=$1 AND (payload::text LIKE '%'||$2||'%' OR result::text LIKE '%'||$2||'%') ORDER BY created_at`, [episodeId, artifactId]);
      for (const row of jobs.rows) {
        const jobNode = await this.recordNode({ ...scope, nodeType: 'worker-execution', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'durable-worker', workerIdentity: row.worker_id }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: artifactNode.node_id, relation: 'EXECUTED_BY_WORKER', targetNodeId: jobNode.node_id }, client);
      }
      const timelines = await client.query('SELECT * FROM timeline_snapshots WHERE episode_id=$1 AND version_id=$2 ORDER BY created_at', [episodeId, artifact.version_id]);
      for (const row of timelines.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'timeline-snapshot', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'timeline' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'DESCRIBES', targetNodeId: versionNode.node_id }, client);
      }
      const qa = await client.query('SELECT * FROM qa_results WHERE artifact_id=$1 ORDER BY created_at', [artifactId]);
      for (const row of qa.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'qa-result', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'qa' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'EVALUATES', targetNodeId: artifactNode.node_id }, client);
      }
      const approvals = await client.query('SELECT * FROM approvals WHERE episode_id=$1 AND target_version_id=$2 ORDER BY decided_at', [episodeId, artifact.version_id]);
      for (const row of approvals.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'approval', sourceId: String(row.id), content: row, payload: nodePayload({ evidence: 'approval' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'DECIDES_ON', targetNodeId: versionNode.node_id }, client);
      }
      const publishes = await client.query('SELECT * FROM publish_runs WHERE episode_id=$1 AND (render_artifact_id=$2 OR package_artifact_id=$2) ORDER BY created_at', [episodeId, artifactId]);
      for (const row of publishes.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'publish-run', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'publish' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'PUBLISHES', targetNodeId: artifactNode.node_id }, client);
      }
      const packages = await client.query('SELECT * FROM episode_packages WHERE episode_id=$1 AND (final_media_artifact_id=$2 OR version_id=$3) ORDER BY created_at', [episodeId, artifactId, artifact.version_id]);
      for (const row of packages.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'episode-package', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'package' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'PACKAGES', targetNodeId: artifactNode.node_id }, client);
      }
      const costs = await client.query('SELECT * FROM cost_records WHERE episode_id=$1 ORDER BY created_at', [episodeId]);
      for (const row of costs.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'usage-cost', sourceId: row.id, content: row, payload: nodePayload({ evidence: 'usage-budget' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'CHARGED_FOR', targetNodeId: artifactNode.node_id }, client);
      }
      const audits = await client.query(`SELECT * FROM audit_events WHERE episode_id=$1 AND (target_id=$2 OR details::text LIKE '%'||$2||'%') ORDER BY created_at`, [episodeId, artifactId]);
      for (const row of audits.rows) {
        const node = await this.recordNode({ ...scope, nodeType: 'audit-event', sourceId: String(row.id), content: row, payload: nodePayload({ evidence: 'audit' }) }, client);
        await this.recordEdge({ ...scope, sourceNodeId: node.node_id, relation: 'EVIDENCES', targetNodeId: artifactNode.node_id }, client);
      }
      return { artifactId, nodeId: artifactNode.node_id, tenantId: scope.tenantId, projectId: scope.projectId };
    });
  }

  async reconcile({ tenantId, projectId = null, mode = 'READ_ONLY', limit = 500, actor = 'reconciler' }) {
    const runId = randomUUID();
    await this.pool.query(`INSERT INTO forge_evidence_reconciliation_runs(id,tenant_id,project_id,mode,status) VALUES($1,$2,$3,$4,'RUNNING')`, [runId, tenantId, projectId, mode]);
    const issues = [];
    const values = [tenantId, projectId, limit];
    const artifacts = await this.pool.query(`SELECT a.*,e.project_id,p.tenant_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.id=$2) ORDER BY a.created_at,a.id LIMIT $3`, values);
    for (const a of artifacts.rows) {
      const node = await this.pool.query('SELECT node_id,content_digest FROM forge_evidence_nodes WHERE tenant_id=$1 AND project_id=$2 AND node_type=\'artifact\' AND source_id=$3', [tenantId, a.project_id, a.id]);
      if (!node.rows[0]) issues.push({ code: 'MISSING_EVIDENCE', artifactId: a.id, detail: 'artifact node missing' });
      else {
        const expected = digest({ kind: a.kind, versionId: a.version_id, contentHash: a.content_hash, storageUri: a.storage_uri, inputVersionIds: a.input_version_ids, providerRunId: a.provider_run_id });
        if (node.rows[0].content_digest !== expected) issues.push({ code: 'CONFLICTING_IDENTITY', artifactId: a.id, detail: 'artifact evidence digest differs' });
      }
      const version = (await this.pool.query('SELECT v.id,e.project_id,p.tenant_id FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE v.id=$1', [a.version_id])).rows[0];
      if (!version) issues.push({ code: 'ORPHAN_ARTIFACT', artifactId: a.id, detail: 'version missing' });
      else if (version.project_id !== a.project_id || version.tenant_id !== tenantId) issues.push({ code: 'CROSS_SCOPE', artifactId: a.id, detail: 'version belongs to another scope' });
      const lifecycle = await this.pool.query('SELECT state FROM artifact_lifecycle_records WHERE artifact_id=$1', [a.id]);
      if (!lifecycle.rows[0]) issues.push({ code: 'MISSING_LIFECYCLE', artifactId: a.id });
      const inputs = Array.isArray(a.input_version_ids) ? a.input_version_ids : [];
      if (inputs.length) {
        const found = await this.pool.query('SELECT id FROM version_records WHERE id=ANY($1::text[]) AND episode_id=$2', [inputs, a.episode_id]);
        if (found.rowCount !== inputs.length) issues.push({ code: 'BROKEN_EDGE', artifactId: a.id, detail: 'input versions missing/cross-episode' });
      }
      if (a.provider_run_id) {
        const run = await this.pool.query('SELECT id FROM provider_runs WHERE id=$1 AND episode_id=$2', [a.provider_run_id, a.episode_id]);
        if (!run.rows[0]) issues.push({ code: 'BROKEN_PROVIDER_LINEAGE', artifactId: a.id });
      }
      const edge = await this.pool.query(`SELECT 1 FROM forge_evidence_edges e JOIN forge_evidence_nodes n ON n.node_id=e.source_node_id WHERE e.relation='DERIVED_FROM_VERSION' AND n.source_id=$1 LIMIT 1`, [a.id]);
      if (!edge.rows[0]) issues.push({ code: 'MISSING_EVIDENCE_EDGE', artifactId: a.id, detail: 'derived-from edge missing' });
    }
    const orphanEdges = await this.pool.query(`SELECT e.edge_id FROM forge_evidence_edges e LEFT JOIN forge_evidence_nodes s ON s.node_id=e.source_node_id LEFT JOIN forge_evidence_nodes t ON t.node_id=e.target_node_id WHERE e.tenant_id=$1 AND ($2::text IS NULL OR e.project_id=$2) AND (s.node_id IS NULL OR t.node_id IS NULL) LIMIT $3`, values);
    for (const row of orphanEdges.rows) issues.push({ code: 'ORPHAN_EDGE', edgeId: row.edge_id });
    const report = canonicalize({ tenantId, projectId, actor, checkedArtifacts: artifacts.rowCount, issues });
    const reportHash = digest(report);
    await this.pool.query(`UPDATE forge_evidence_reconciliation_runs SET status='SUCCEEDED',checked_nodes=(SELECT count(*) FROM forge_evidence_nodes WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)),checked_edges=(SELECT count(*) FROM forge_evidence_edges WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2)),issue_count=$3,report_hash=$4,report=$5::jsonb,finished_at=now() WHERE id=$6`, [tenantId, projectId, issues.length, reportHash, JSON.stringify(report), runId]);
    this.observability?.metrics?.inc('forge_evidence_reconciliation_total', { outcome: issues.length ? 'issues' : 'clean' });
    this.observability?.metrics?.observe?.('forge_evidence_reconciliation_issues', {}, issues.length);
    return { id: runId, status: 'SUCCEEDED', issueCount: issues.length, reportHash, report };
  }

  async snapshot({ tenantId, projectId, episodeId = null, versionId = null, createdBy = 'system' }) {
    const nodes = await this.pool.query(`SELECT * FROM forge_evidence_nodes WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR payload->>'episodeId'=$3) ORDER BY node_type,source_id,node_id`, [tenantId, projectId, episodeId]);
    const nodeIds = nodes.rows.map((n) => n.node_id);
    const edges = nodeIds.length ? await this.pool.query(`SELECT * FROM forge_evidence_edges WHERE tenant_id=$1 AND project_id=$2 AND source_node_id=ANY($3::char(64)[]) AND target_node_id=ANY($3::char(64)[]) ORDER BY source_node_id,relation,target_node_id,edge_id`, [tenantId, projectId, nodeIds]) : { rows: [] };
    const graph = canonicalize({ schemaVersion: '1', tenantId, projectId, episodeId, versionId, nodes: nodes.rows, edges: edges.rows });
    const snapshotDigest = digest(graph);
    const snapshotId = snapshotIdentity({ tenantId, projectId, episodeId: episodeId || '', versionId: versionId || '', snapshotDigest });
    await this.pool.query(`INSERT INTO forge_evidence_snapshots(snapshot_id,tenant_id,project_id,episode_id,version_id,snapshot_digest,graph,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (snapshot_id) DO NOTHING`, [snapshotId, tenantId, projectId, episodeId, versionId, snapshotDigest, JSON.stringify(graph), createdBy]);
    return { snapshotId, snapshotDigest, graph };
  }

  async verifySnapshot({ snapshotId, tenantId, projectId }) {
    const row = (await this.pool.query('SELECT * FROM forge_evidence_snapshots WHERE snapshot_id=$1 AND tenant_id=$2 AND project_id=$3', [snapshotId, tenantId, projectId])).rows[0];
    if (!row) throw Object.assign(new Error('snapshot not found'), { code: 'NOT_FOUND' });
    const actual = digest(row.graph);
    return { valid: actual === row.snapshot_digest, expected: row.snapshot_digest, actual, snapshotId: row.snapshot_id };
  }
}

module.exports = { ProvenanceEvidenceGraph, canonicalize, digest, nodeIdentity, edgeIdentity, snapshotIdentity };
