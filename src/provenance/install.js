const { ProvenanceEvidenceGraph } = require('./evidence-graph');

function installProvenance(ProductionRepository) {
  if (!ProductionRepository || ProductionRepository.prototype.__forgeProvenanceInstalled) return;
  const graphFor = (repository) => {
    if (!repository.__forgeProvenanceGraph) repository.__forgeProvenanceGraph = new ProvenanceEvidenceGraph({ pool: repository.pool || repository.db?.pool });
    return repository.__forgeProvenanceGraph;
  };
  const wrap = (name, after) => {
    const original = ProductionRepository.prototype[name];
    if (typeof original !== 'function') return;
    ProductionRepository.prototype[name] = async function wrappedProvenance(...args) {
      const result = await original.apply(this, args);
      await after.call(this, result, args, graphFor(this));
      return result;
    };
  };
  wrap('registerArtifact', async function (artifact, args, graph) {
    await graph.ensureArtifactChain({ artifactId: artifact.id, actor: args[0]?.createdBy || 'artifact-gateway', reason: 'artifact-registered' });
  });
  wrap('recordQa', async function (qa, args, graph) {
    if (qa?.artifact_id) await graph.ensureArtifactChain({ artifactId: qa.artifact_id, actor: args[0]?.runner || 'qa', reason: 'qa-recorded' });
  });
  wrap('appendApproval', async function (approval, args, graph) {
    const input = args[0] || {};
    const db = this.db || this;
    if (input.episodeId && input.targetVersionId) {
      const artifacts = await db.pool.query('SELECT id FROM artifacts WHERE episode_id=$1 AND version_id=$2', [input.episodeId, input.targetVersionId]);
      for (const row of artifacts.rows) await graph.ensureArtifactChain({ artifactId: row.id, actor: input.actor || 'approval', reason: 'approval-recorded' });
    }
  });
  wrap('transitionProviderRun', async function (run, args, graph) {
    const ids = Array.isArray(run?.result_artifact_ids) ? run.result_artifact_ids : [];
    for (const artifactId of ids) await graph.ensureArtifactChain({ artifactId, actor: 'provider-run', reason: `provider-run:${run.id}` });
  });
  ProductionRepository.prototype.provenanceGraph = function provenanceGraph() { return graphFor(this); };
  ProductionRepository.prototype.__forgeProvenanceInstalled = true;
}

module.exports = { installProvenance };
