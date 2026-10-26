const crypto = require('node:crypto');

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateResearchPackage(input = {}) {
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const sourceIds = new Set(sources.map((source) => source.id));
  if (!claims.length && !sources.length) throw new TypeError('research package must contain sources or claims');
  for (const [index, source] of sources.entries()) {
    if (!source.id || !/^https?:\/\//i.test(String(source.url || ''))) throw new TypeError(`sources[${index}] requires id and http(s) url`);
  }
  for (const [index, claim] of claims.entries()) {
    if (!claim.id || !String(claim.claim || '').trim()) throw new TypeError(`claims[${index}] requires id and claim`);
    for (const sourceId of claim.sourceIds || []) {
      if (!sourceIds.has(sourceId)) throw new Error(`Claim ${claim.id} references unknown source ${sourceId}`);
    }
  }
  return Object.freeze({
    sources: sources.map((source) => ({ ...source })),
    claims: claims.map((claim) => ({ ...claim, sourceIds: [...new Set(claim.sourceIds || [])] })),
    hash: hashJson({ sources, claims }),
  });
}

const TRACKS = new Set(['VIDEO', 'NARRATION', 'MUSIC', 'SFX', 'CAPTIONS', 'OVERLAYS']);

function validateTimeline(timeline = {}) {
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  if (!tracks.length) throw new TypeError('timeline.tracks must be non-empty');
  let maxEnd = 0;
  const ids = new Set();
  for (const [trackIndex, track] of tracks.entries()) {
    if (!TRACKS.has(track.type)) throw new TypeError(`tracks[${trackIndex}].type is invalid`);
    if (!Array.isArray(track.segments)) throw new TypeError(`tracks[${trackIndex}].segments must be an array`);
    let cursor = 0;
    for (const [segmentIndex, segment] of track.segments.entries()) {
      if (!segment.id || ids.has(segment.id)) throw new TypeError(`segment id missing or duplicated at ${trackIndex}:${segmentIndex}`);
      ids.add(segment.id);
      const start = Number(segment.start);
      const duration = Number(segment.duration);
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) {
        throw new TypeError(`segment ${segment.id} requires non-negative start and positive duration`);
      }
      if (start < cursor - 0.001) throw new Error(`segments overlap or are out of order on ${track.type}`);
      cursor = start + duration;
      maxEnd = Math.max(maxEnd, cursor);
    }
  }
  const declared = timeline.durationSeconds == null ? maxEnd : Number(timeline.durationSeconds);
  if (!Number.isFinite(declared) || declared < maxEnd - 0.001 || declared <= 0) throw new TypeError('timeline durationSeconds is inconsistent');
  return Object.freeze({ timeline, durationSeconds: declared, contentHash: hashJson(timeline) });
}

function validatePublishRequest({ episode, renderArtifact, qaStatus, metadata = {} }) {
  if (!episode || !renderArtifact) throw new TypeError('episode and renderArtifact are required');
  if (episode.state !== 'APPROVED' && episode.state !== 'PUBLISHED') throw new Error('Episode must be approved before publishing');
  if (episode.approvedRenderId !== renderArtifact.id) throw new Error('Publish render must equal the approved render');
  if (!['PASSED', 'WARNINGS'].includes(qaStatus)) throw new Error('A passing QA result is required before publishing');
  if (!metadata.title || !String(metadata.title).trim()) throw new TypeError('publish metadata.title is required');
  return Object.freeze({ destination: metadata.destination || 'youtube', metadata: { ...metadata } });
}

function buildHandoffEnvelope(manifest) {
  if (!manifest || manifest.contract?.consumerRepository !== 'akashdnb/purffle-shorts') throw new TypeError('Invalid Shorts handoff contract');
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    handoffId: manifest.handoffId,
    source: manifest.source,
    artifacts: manifest.artifacts,
    candidateSegments: manifest.candidateSegments || [],
    contract: manifest.contract,
  });
}

module.exports = { hashJson, validateResearchPackage, validateTimeline, validatePublishRequest, buildHandoffEnvelope };
