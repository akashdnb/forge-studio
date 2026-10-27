function conflict(message, code = 'CONFLICT', details = {}) {
  return Object.assign(new Error(message), { code, concurrency: true, details });
}

function revisionConflict(resource, expected, actual) {
  return conflict(`${resource} revision conflict`, 'REVISION_CONFLICT', { expected, actual });
}

function stateConflict(message, details = {}) {
  return conflict(message, 'STATE_CONFLICT', details);
}

function provenanceConflict(message, details = {}) {
  return conflict(message, 'INVALID_PROVENANCE', details);
}

function assertExpectedRevision(row, expectedRevision, resource = 'Episode') {
  if (expectedRevision !== undefined && Number(row.revision) !== Number(expectedRevision)) {
    throw revisionConflict(resource, Number(expectedRevision), Number(row.revision));
  }
}

function assertSameEpisode(ownerEpisodeId, childEpisodeId, message = 'Resource belongs to a different episode') {
  if (ownerEpisodeId !== childEpisodeId) throw provenanceConflict(message, { ownerEpisodeId, childEpisodeId });
}

function isConcurrencyError(error) {
  return Boolean(error?.concurrency) || ['REVISION_CONFLICT', 'STATE_CONFLICT', 'INVALID_PROVENANCE', 'INVALID_DEPENDENCY', 'QA_BLOCKED', 'APPROVAL_BLOCKED', 'STALE_ARTIFACT'].includes(error?.code);
}

module.exports = { conflict, revisionConflict, stateConflict, provenanceConflict, assertExpectedRevision, assertSameEpisode, isConcurrencyError };
