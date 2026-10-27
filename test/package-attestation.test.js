const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sha256, redactSecrets, buildAttestation, verifyAttestationSignature, diagnosticsForDrift, assertSafeReattestation, toolchainFingerprint } = require('../src/attestation/package-attestation');

test('canonical JSON is deterministic across object key order', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, z: 1 }));
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
});

test('secret-shaped fields are redacted from attestation inputs', () => {
  const value = redactSecrets({ token: 'secret-value', nested: { password: 'pw', visible: 'ok' } });
  assert.equal(value.token, '[REDACTED]');
  assert.equal(value.nested.password, '[REDACTED]');
  assert.equal(value.nested.visible, 'ok');
});

test('attestation signatures verify and fail closed after payload mutation', () => {
  const secret = 'test-only-signing-secret';
  const attestation = buildAttestation({ inputs: { source: ['v1'], toolchain: toolchainFingerprint({ ffmpeg: 'ffmpeg 7.0' }) }, packageManifestHash: 'a'.repeat(64), packageArtifactHash: 'b'.repeat(64) }, secret);
  assert.equal(verifyAttestationSignature(attestation, secret), true);
  const mutated = { ...attestation, payload: { ...attestation.payload, inputs: { source: ['v2'], toolchain: attestation.inputs.toolchain } } };
  assert.equal(verifyAttestationSignature(mutated, secret), false);
});

test('drift diagnostics distinguish replay and toolchain mismatch', () => {
  const inputs = { toolchain: toolchainFingerprint({ ffmpeg: 'ffmpeg 7.0' }), source: ['v1'] };
  const attestation = { buildFingerprint: sha256(canonicalJson({ toolchain: inputs.toolchain, source: ['v0'] })), packageManifestHash: 'a'.repeat(64), inputs: { toolchain: inputs.toolchain } };
  const changedToolchain = toolchainFingerprint({ ffmpeg: 'ffmpeg 8.0' });
  const diagnostics = diagnosticsForDrift({ attestation, currentInputs: { ...inputs, toolchain: changedToolchain }, packageHash: 'a'.repeat(64), currentPackageHash: 'a'.repeat(64), currentToolchain: changedToolchain });
  assert.ok(diagnostics.some((item) => item.code === 'REPLAY_DIVERGENCE'));
  assert.ok(diagnostics.some((item) => item.code === 'TOOLCHAIN_MISMATCH'));
});

test('unsafe re-attestation requires operator approval and blocks published packages', () => {
  assert.throws(() => assertSafeReattestation({ diagnostics: [{ code: 'TOOLCHAIN_MISMATCH' }], packagePublished: false, operatorApproved: false, reason: 'TOOLCHAIN_MISMATCH' }), /Operator approval/);
  assert.throws(() => assertSafeReattestation({ diagnostics: [{ code: 'TOOLCHAIN_MISMATCH' }], packagePublished: true, operatorApproved: true, reason: 'TOOLCHAIN_MISMATCH' }), /Published packages/);
  assert.doesNotThrow(() => assertSafeReattestation({ diagnostics: [{ code: 'TOOLCHAIN_MISMATCH' }], packagePublished: false, operatorApproved: true, reason: 'TOOLCHAIN_MISMATCH' }));
});
