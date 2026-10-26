const { requiredString } = require('../domain/records');

function createShortsHandoff({ episode, renderArtifact, scriptArtifact = null, scenePlanArtifact = null, captionsArtifact = null, candidateSegments = [] }) {
  if (!episode) throw new TypeError('episode is required');
  if (!renderArtifact) throw new TypeError('renderArtifact is required');
  if (!['APPROVED', 'PUBLISHED'].includes(episode.state)) throw new Error('Only an approved/published episode can be handed off to Shorts');
  if (episode.approvedRenderId !== renderArtifact.id) throw new Error('Handoff render must equal the episode approved render');
  if (renderArtifact.episodeId !== episode.id) throw new Error('Render artifact belongs to another episode');
  if (!renderArtifact.versionId) throw new TypeError('Render artifact versionId is required');

  const segments = candidateSegments.map((segment, index) => {
    const startSeconds = Number(segment.startSeconds);
    const endSeconds = Number(segment.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
      throw new TypeError(`candidateSegments[${index}] must have valid startSeconds/endSeconds`);
    }
    return {
      id: requiredString(segment.id || `segment-${index + 1}`, `candidateSegments[${index}].id`),
      startSeconds,
      endSeconds,
      title: segment.title || '',
      reason: segment.reason || '',
      transcript: segment.transcript || '',
      score: Number.isFinite(segment.score) ? segment.score : null,
      sourceSceneVersionIds: [...new Set(segment.sourceSceneVersionIds || [])],
    };
  });

  return Object.freeze({
    schemaVersion: '1.0',
    handoffId: `shorts-handoff:${episode.id}:${renderArtifact.versionId}`,
    createdAt: new Date().toISOString(),
    source: {
      repository: 'akashdnb/forge-studio',
      episodeId: episode.id,
      projectId: episode.projectId,
      title: episode.title,
      episodeState: episode.state,
      approvedRenderId: renderArtifact.id,
      renderVersionId: renderArtifact.versionId,
      renderUri: renderArtifact.storageUri || null,
      renderContentHash: renderArtifact.contentHash || null,
    },
    artifacts: {
      script: scriptArtifact ? { id: scriptArtifact.id, versionId: scriptArtifact.versionId, contentHash: scriptArtifact.contentHash || null, storageUri: scriptArtifact.storageUri || null, content: scriptArtifact.content || null } : null,
      scenePlan: scenePlanArtifact ? { id: scenePlanArtifact.id, versionId: scenePlanArtifact.versionId, contentHash: scenePlanArtifact.contentHash || null, storageUri: scenePlanArtifact.storageUri || null, content: scenePlanArtifact.content || null } : null,
      captions: captionsArtifact ? { id: captionsArtifact.id, versionId: captionsArtifact.versionId, contentHash: captionsArtifact.contentHash || null, storageUri: captionsArtifact.storageUri || null, content: captionsArtifact.content || null } : null,
    },
    candidateSegments: segments,
    contract: {
      consumerRepository: 'akashdnb/purffle-shorts',
      sourceIsAuthoritative: true,
      mediaMustBeCopiedOrFetchedByApprovedStorageAdapter: true,
      preserveSourceEpisodeAndVersionIds: true,
      noPublicationPermissionGranted: true,
    },
  });
}

module.exports = { createShortsHandoff };
