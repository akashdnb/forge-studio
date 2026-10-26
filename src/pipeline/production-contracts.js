const crypto = require('node:crypto');

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateResearchPackage(input = {}) {
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const claims = Array.isArray(input.claims) ? input.claims : [];
  if (!claims.length && !sources.length) throw new TypeError('research package must contain sources or claims');
  const sourceIds = new Set();
  for (const [index, source] of sources.entries()) {
    if (!source || typeof source !== 'object' || !source.id || !/^https?:\/\//i.test(String(source.url || ''))) {
      throw new TypeError(`sources[${index}] requires id and http(s) url`);
    }
    if (sourceIds.has(source.id)) throw new TypeError(`duplicate research source id: ${source.id}`);
    sourceIds.add(source.id);
  }
  const claimIds = new Set();
  for (const [index, claim] of claims.entries()) {
    if (!claim || typeof claim !== 'object' || !claim.id || !String(claim.claim || '').trim()) {
      throw new TypeError(`claims[${index}] requires id and claim`);
    }
    if (claimIds.has(claim.id)) throw new TypeError(`duplicate research claim id: ${claim.id}`);
    claimIds.add(claim.id);
    if (!Array.isArray(claim.sourceIds || [])) throw new TypeError(`claims[${index}].sourceIds must be an array`);
    for (const sourceId of claim.sourceIds || []) if (!sourceIds.has(sourceId)) throw new Error(`Claim ${claim.id} references unknown source ${sourceId}`);
  }
  const sanitizedSources = sources.map((source) => ({
    id: String(source.id), url: String(source.url), title: String(source.title || ''),
    publisher: String(source.publisher || ''), publishedAt: source.publishedAt || null,
    contentHash: source.contentHash || null, metadata: source.metadata || {},
  }));
  const sanitizedClaims = claims.map((claim) => ({
    id: String(claim.id), claim: String(claim.claim).trim(), status: claim.status || 'DISCOVERED',
    sourceIds: [...new Set(claim.sourceIds || [])], metadata: claim.metadata || {},
  }));
  return Object.freeze({
    sources: sanitizedSources,
    claims: sanitizedClaims,
    status: input.status || 'DRAFT',
    notes: String(input.notes || ''),
    hash: hashJson({ sources: sanitizedSources, claims: sanitizedClaims }),
  });
}

const TRACKS = new Set(['VIDEO', 'NARRATION', 'MUSIC', 'SFX', 'CAPTIONS', 'OVERLAYS']);

function validateTimeline(input = {}) {
  // Accept either { tracks, durationSeconds } or { timeline: { tracks, durationSeconds } }.
  const timeline = input.timeline && typeof input.timeline === 'object' ? input.timeline : input;
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  if (!tracks.length) throw new TypeError('timeline.tracks must be non-empty');
  let maxEnd = 0;
  const ids = new Set();
  for (const [trackIndex, track] of tracks.entries()) {
    if (!track || !TRACKS.has(track.type)) throw new TypeError(`tracks[${trackIndex}].type is invalid`);
    if (!Array.isArray(track.segments)) throw new TypeError(`tracks[${trackIndex}].segments must be an array`);
    let cursor = 0;
    for (const [segmentIndex, segment] of track.segments.entries()) {
      if (!segment || !segment.id || ids.has(segment.id)) throw new TypeError(`segment id missing or duplicated at ${trackIndex}:${segmentIndex}`);
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
  return Object.freeze({ timeline, durationSeconds: declared, contentHash: hashJson(timeline), versionId: input.versionId, id: input.id });
}

function validatePublishRequest({ episode, renderArtifact, qaStatus, metadata = {} }) {
  if (!episode || !renderArtifact) throw new TypeError('episode and renderArtifact are required');
  if (episode.state !== 'APPROVED' && episode.state !== 'PUBLISHED') throw new Error('Episode must be approved before publishing');
  if (episode.approvedRenderId !== renderArtifact.id) throw new Error('Publish render must equal the approved render');
  if (!['PASSED', 'WARNINGS'].includes(qaStatus)) throw new Error('A passing QA result is required before publishing');
  if (!metadata.title || !String(metadata.title).trim()) throw new TypeError('publish metadata.title is required');
  const destination = metadata.destination || 'youtube';
  if (destination !== 'youtube') throw Object.assign(new Error('Only YouTube publishing is supported'), { retryable: false });
  return Object.freeze({ destination, metadata: { ...metadata, destination } });
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
