const { validateMediaArtifact: validateRaw } = require('./media-qa');

// Compatibility wrapper for the initial validator implementation: preserve the
// public result contract as {expected, checksum} even if an older internal
// validator emitted those two fields in reverse order.
async function validateMediaArtifact(options) {
  const result = await validateRaw(options);
  if (result && result.expected && result.expected.hash && result.checksum && !result.checksum.hash) {
    return { ...result, expected: result.checksum, checksum: result.expected };
  }
  return result;
}

module.exports = { validateMediaArtifact };
