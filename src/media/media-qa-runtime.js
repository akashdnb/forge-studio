const { validateMediaArtifact: validateRaw, parseExpectedMetadata } = require('./media-qa');

function expectedFromOptions(options = {}) {
  const artifactExpected = parseExpectedMetadata(options.artifact?.metadata || {});
  const payloadExpected = parseExpectedMetadata(options.payload?.timelineMetadata || options.payload?.metadata || {});
  const merged = { ...artifactExpected };
  for (const [key, value] of Object.entries(payloadExpected)) if (value !== null && value !== undefined) merged[key] = value;
  return merged;
}

async function validateMediaArtifact(options) {
  const result = await validateRaw(options);
  return {
    ...result,
    expected: expectedFromOptions(options),
    checksum: result.expected?.hash ? result.expected : result.checksum,
  };
}

module.exports = { validateMediaArtifact, expectedFromOptions };
