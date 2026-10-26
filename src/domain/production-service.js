const { EpisodeService } = require('./episode-service');
const { ArtifactRegistry } = require('./artifact-registry');
const { ProviderRunLedger } = require('./provider-run-ledger');
const { ApprovalService } = require('./approval-service');
const { QAService } = require('./qa-service');
const { VersionGraph } = require('./version-graph');

class ProductionService {
  constructor() {
    this.episodes = new EpisodeService();
    this.artifacts = new ArtifactRegistry();
    this.providerRuns = new ProviderRunLedger();
    this.approvals = new ApprovalService();
    this.qa = new QAService();
    this.graph = new VersionGraph();
  }

  getEpisodeSummary(episodeId) {
    const episode = this.episodes.get(episodeId);
    if (!episode) return undefined;
    return {
      episode,
      artifacts: this.artifacts.listByEpisode(episodeId),
      providerRuns: this.providerRuns.listByEpisode(episodeId),
      cost: this.providerRuns.episodeCost(episodeId),
    };
  }

  approveFinalRender({ approvalId, episodeId, renderArtifactId, renderVersionId, actor, comments = '' }) {
    const episode = this.episodes.get(episodeId);
    if (!episode) throw new Error(`Unknown episode: ${episodeId}`);
    if (episode.currentRenderId !== renderArtifactId) throw new Error('Render is not the current selected render');
    const artifact = this.artifacts.get(renderArtifactId);
    if (!artifact || artifact.episodeId !== episodeId || artifact.versionId !== renderVersionId) {
      throw new Error('Render artifact/version provenance mismatch');
    }
    if (!this.qa.canApprove(renderArtifactId, renderVersionId)) {
      throw new Error('Current render has no passing or warning-only QA result');
    }
    this.approvals.decide({
      id: approvalId, episodeId, stage: 'FINAL_RENDER', targetId: renderArtifactId,
      targetVersionId: renderVersionId, decision: 'APPROVED', actor, comments,
      evidence: { qaResultId: this.qa.latestForArtifact(renderArtifactId).id },
    });
    if (episode.state === 'AWAITING_APPROVAL') {
      const approved = this.episodes.markApproved(episodeId, renderArtifactId);
      return { episode: approved, approval: this.approvals.latestForTarget({ episodeId, stage: 'FINAL_RENDER', targetId: renderArtifactId }) };
    }
    return { episode, approval: this.approvals.latestForTarget({ episodeId, stage: 'FINAL_RENDER', targetId: renderArtifactId }) };
  }
}

module.exports = { ProductionService };
