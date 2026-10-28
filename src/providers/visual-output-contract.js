'use strict';

function fail(message, code = 'MALFORMED_PROVIDER_RESPONSE') {
  return Object.assign(new Error(message), { code, retryable: false });
}

function validateVisualProviderResult(result, { capability, request = {} } = {}) {
  if (!result || !Array.isArray(result.artifacts) || result.artifacts.length === 0) throw fail('Visual provider must return at least one artifact');
  const expectedPrefix = capability === 'video-generation' ? 'video/' : capability === 'image-generation' ? 'image/' : null;
  const artifacts = result.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') throw fail(`Visual provider artifact ${index + 1} is invalid`);
    const hasContent = artifact.content !== undefined && artifact.content !== null && artifact.content !== '';
    const hasUrl = typeof artifact.url === 'string' && artifact.url.length > 0;
    if (!hasContent && !hasUrl) throw fail(`Visual provider artifact ${index + 1} has no content or URL`);
    const contentType = String(artifact.contentType || artifact.mediaType || '').toLowerCase();
    if (!contentType) throw fail(`Visual provider artifact ${index + 1} is missing content type`);
    if (expectedPrefix && !contentType.startsWith(expectedPrefix)) throw fail(`Visual provider artifact ${index + 1} content type ${contentType} is incompatible with ${capability}`);
    if (capability === 'video-generation' && request.contentType && request.contentType !== contentType) throw fail(`Visual provider returned ${contentType}; requested ${request.contentType}`);
    return { ...artifact, contentType };
  });
  return { ...result, artifacts };
}

module.exports = { validateVisualProviderResult };
