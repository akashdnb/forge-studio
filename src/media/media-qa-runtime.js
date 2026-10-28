const { validateMediaArtifact: validateRaw, parseExpectedMetadata } = require('./media-qa');

function expectedFromOptions(options = {}) {
  const artifactExpected = parseExpectedMetadata(options.artifact?.metadata || {});
  const payloadExpected = parseExpectedMetadata(options.payload?.timelineMetadata || options.payload?.metadata || {});
  const merged = { ...artifactExpected };
  for (const [key, value] of Object.entries(payloadExpected)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function audioDurationCheck(result, expected) {
  const expectedSeconds = expected.durationSeconds;
  if (expectedSeconds == null) {
    return {
      name: 'audio_duration',
      status: 'WARN',
      message: 'Encoded audio duration could not be compared because expected timeline duration is missing',
      details: { actualSeconds: null, expectedSeconds: null, toleranceSeconds: expected.durationToleranceSeconds ?? null },
    };
  }
  const audioStream = result.probe?.streams?.find((stream) => stream.codecType === 'audio');
  const actualSeconds = Number(audioStream?.duration);
  const toleranceSeconds = expected.durationToleranceSeconds ?? 0.5;
  const pass = Number.isFinite(actualSeconds) && Math.abs(actualSeconds - expectedSeconds) <= toleranceSeconds;
  return {
    name: 'audio_duration',
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? 'Encoded audio stream duration matches the expected timeline within tolerance'
      : 'Encoded audio stream duration is missing or outside the expected timeline tolerance',
    details: { actualSeconds: Number.isFinite(actualSeconds) ? actualSeconds : null, expectedSeconds, toleranceSeconds },
  };
}

async function validateMediaArtifact(options) {
  const result = await validateRaw(options);
  const expected = expectedFromOptions(options);
  const audioDuration = audioDurationCheck(result, expected);
  const checks = [...(result.checks || []), audioDuration];
  const status = checks.some((check) => check.status === 'FAIL')
    ? 'FAILED'
    : checks.some((check) => check.status === 'WARN')
      ? 'WARNINGS'
      : 'PASSED';
  return { ...result, status, checks, expected, checksum: result.expected?.hash ? result.expected : result.checksum };
}

module.exports = { validateMediaArtifact, expectedFromOptions };
