const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  createDeterministicProvider, createProviderRegistry, deterministicWav, extractScriptText,
  executeNarration, validateAudio, wavInfo, sha256,
} = require('../src/narration/tts-worker');

function fixturePool({ existing = null, scriptText = 'A deterministic long-form narration.' } = {}) {
  const script = { id: 'script-v1', episode_id: 'ep-1', kind: 'script', content_hash: sha256(JSON.stringify({ text: scriptText })), payload: { text: scriptText } };
  return {
    script,
    async query(sql) {
      if (sql.includes('FROM episodes')) return { rows: [{ id: 'ep-1', project_id: 'project-1', current_versions: { script: 'script-v1' }, state: 'SCRIPT_APPROVED' }] };
      if (sql.includes('FROM approvals')) return { rows: [{ target_version_id: 'script-v1' }] };
      if (sql.includes('FROM version_records')) return { rows: [script] };
      if (sql.includes("FROM artifacts")) return { rows: existing ? [existing] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function fakeStorage() {
  return { async upload({ stream, expectedSha256, contentType }) {
    const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks); const digest = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(digest, expectedSha256); return { uri: `memory://audio/${digest}`, key: `audio/${digest}`, sha256: digest, sizeBytes: content.length, contentType };
  } };
}

function fakeArtifactStorage() {
  return { async putArtifact({ artifactId, episodeId, versionId, content, expectedSha256, contentType, metadata }) {
    assert.equal(episodeId, 'ep-1'); assert.equal(sha256(content), expectedSha256); assert.equal(metadata.sha256, expectedSha256); return { id: artifactId, episode_id: episodeId, version_id: versionId, content_hash: expectedSha256, media_type: contentType };
  } };
}

test('deterministic local provider produces valid bounded PCM WAV and stable checksum', () => {
  const first = deterministicWav('hello world'); const second = deterministicWav('hello world');
  assert.deepEqual(first, second); const info = wavInfo(first); assert.equal(info.container, 'wav'); assert.equal(info.codec, 'pcm'); assert.equal(info.channels, 1); assert.equal(info.sampleRate, 22050); assert.ok(info.durationSeconds > 0); assert.equal(validateAudio(first, 'audio/wav', info).sha256, sha256(first));
});

test('extracts only supported narration text fields', () => { assert.equal(extractScriptText({ text: 'hello' }), 'hello'); assert.equal(extractScriptText({ scenes: [{ narration: 'one' }, { voiceover: 'two' }] }), 'one\n\ntwo'); assert.throws(() => extractScriptText({ title: 'missing' }), /narration text/); });

test('rejects malformed, empty, unsupported and silent provider output', () => {
  assert.throws(() => validateAudio(Buffer.alloc(256), 'audio/wav', { durationSeconds: 1, channels: 1, sampleRate: 22050 }), /silent/);
  assert.throws(() => validateAudio(Buffer.from('not-audio'), 'audio/wav', { durationSeconds: 1, channels: 1, sampleRate: 22050 }), /truncated/);
  assert.throws(() => validateAudio(deterministicWav('bad'), 'video/mp4', wavInfo(deterministicWav('bad'))), /Unsupported/);
});

test('provider registry selects deterministic mode without production credentials', () => {
  const registry = createProviderRegistry({ provider: createDeterministicProvider() }); assert.equal(registry.get('tts').name, 'deterministic-local');
});

test('narration success persists immutable audio metadata with provenance and checksum', async () => {
  const pool = fixturePool(); const providerRegistry = createProviderRegistry({ provider: createDeterministicProvider() });
  const result = await executeNarration({ pool, storage: fakeArtifactStorage(), providerRegistry, payload: { episodeId: 'ep-1' }, job: { id: 'job-1', attempt: 1, created_by: 'test' } });
  assert.match(result.artifactId, /^narration-audio:/); assert.match(result.versionId, /^narration:/); assert.ok(result.contentHash); assert.ok(result.durationSeconds > 0); assert.equal(result.idempotent, false);
});

test('same approved input and configuration is idempotent', async () => {
  const pool = fixturePool(); const providerRegistry = createProviderRegistry({ provider: createDeterministicProvider() }); const first = await executeNarration({ pool, storage: fakeArtifactStorage(), providerRegistry, payload: { episodeId: 'ep-1' }, job: { id: 'job-1' } });
  const secondPool = fixturePool({ existing: { id: first.artifactId, version_id: first.versionId, content_hash: first.contentHash, metadata: { inputFingerprint: first.versionId.slice('narration:'.length) } } });
  // Reuse the same exact identity; the stored metadata fingerprint is checked by the worker.
  const second = await executeNarration({ pool: secondPool, storage: fakeArtifactStorage(), providerRegistry, payload: { episodeId: 'ep-1' }, job: { id: 'job-2' } });
  assert.equal(second.idempotent, true); assert.equal(second.artifactId, first.artifactId);
});

test('timeout and provider failures remain retryable while malformed output is terminal', async () => {
  const pool = fixturePool(); const timeoutProvider = { name: 'timeout', execute: async () => { const error = new Error('deadline'); error.code = 'PROVIDER_TIMEOUT'; error.retryable = true; throw error; } };
  await assert.rejects(() => executeNarration({ pool, storage: fakeArtifactStorage(), providerRegistry: createProviderRegistry({ provider: timeoutProvider }), payload: { episodeId: 'ep-1' } }), (error) => error.code === 'PROVIDER_TIMEOUT' && error.retryable === true);
  const badProvider = { name: 'bad', execute: async () => ({ audio: Buffer.from('broken'), contentType: 'audio/wav' }) };
  await assert.rejects(() => executeNarration({ pool, storage: fakeArtifactStorage(), providerRegistry: createProviderRegistry({ provider: badProvider }), payload: { episodeId: 'ep-1' } }), (error) => error.code === 'INVALID_OUTPUT' && error.retryable === false);
});

test('cancellation prevents provider execution and artifact publication', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const provider = { name: 'must-not-run', execute: async () => { called = true; return { audio: deterministicWav('x'), contentType: 'audio/wav' }; } };
  await assert.rejects(() => executeNarration({ pool: fixturePool(), storage: fakeArtifactStorage(), providerRegistry: createProviderRegistry({ provider }), payload: { episodeId: 'ep-1' }, signal: controller.signal }), (error) => error.code === 'CANCELLED');
  assert.equal(called, false);
});
