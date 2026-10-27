const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerationWorker, validateImage, validateText, strictBase64, generationIdentity } = require('../src/generation/generation-worker');
const { GenerationProviderRegistry, HttpGenerationProvider, createGenerationProviderRegistry, parseRetryAfter } = require('../src/generation/provider-registry');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAEElEQVR42mNgGAWjYBTAAAADEAAB1y2EYwAAAABJRU5ErkJggg==', 'base64');

function makeWorker({ capability = 'text', provider, poolOverrides = {}, storageUpload } = {}) {
  const state = { versions: [], artifacts: [], runs: new Map(), transitions: [], uploads: 0 };
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('SELECT id,project_id,current_versions FROM episodes')) return { rows: [{ id: 'ep', project_id: 'project', current_versions: { script: 'script:1', scene_plan: 'scene:1' } }] };
      if (sql.includes('SELECT id,kind,episode_id,content_hash,payload FROM version_records')) return { rows: state.versions.filter((v) => params[1]?.includes(v.id)) };
      if (sql.includes('SELECT 1 FROM approvals')) return { rows: [{ ok: 1 }] };
      if (sql.includes('SELECT id,episode_id,kind,content_hash FROM version_records')) return { rows: state.versions.filter((v) => v.id === params[0]) };
      if (sql.includes('INSERT INTO version_records')) { state.versions.push({ id: params[0], episode_id: params[1], kind: params[2], content_hash: params[4], payload: JSON.parse(params[3]) }); return { rows: [] }; }
      if (sql.includes('INSERT INTO version_dependencies')) return { rows: [] };
      if (sql.includes('SELECT status FROM forge_jobs')) return { rows: [{ status: 'RUNNING' }] };
      if (sql.includes('SELECT * FROM artifacts')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    ...poolOverrides,
  };
  state.versions.push({ id: 'script:1', kind: 'script', episode_id: 'ep', content_hash: 's'.repeat(64), payload: { text: 'approved script' } });
  const repository = {
    db: { pool },
    createProviderRun: async (input) => {
      const existing = state.runs.get(input.idempotencyKey);
      if (existing) return existing;
      const run = { id: input.id, status: 'QUEUED', result_artifact_ids: [], idempotency_key: input.idempotencyKey };
      state.runs.set(input.idempotencyKey, run); return run;
    },
    transitionProviderRun: async ({ id, status, patch = {} }) => {
      const run = [...state.runs.values()].find((item) => item.id === id); run.status = status; Object.assign(run, patch); state.transitions.push({ id, status, patch }); return run;
    },
    registerArtifact: async (input) => { state.artifacts.push(input); return input; },
  };
  const storage = { upload: async ({ stream, expectedSha256, contentType }) => { state.uploads += 1; const chunks = []; for await (const chunk of stream) chunks.push(chunk); return { key: `generation/${expectedSha256}`, uri: `storage://${expectedSha256}`, sha256: expectedSha256, sizeBytes: Buffer.concat(chunks).length, contentType }; }, download: async () => ({ stream: require('node:stream').Readable.from([]) }) };
  const registry = new GenerationProviderRegistry(); registry.register(capability, provider || { name: 'test-provider', model: 'v1', execute: async () => ({ artifact: { content: 'hello world', mediaType: 'text/plain' } }) });
  return { worker: new GenerationWorker({ repository, storage, providerRegistry: registry, config: { timeoutMs: 1000, maxOutputBytes: 1024 * 1024 }, probeVideo: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 16, height: 16 }], format: { duration: 1 } }), logger: { warn() {} } }), state };
}

const approvedTextRequest = { episodeId: 'ep', inputVersionIds: ['script:1'], generationRequests: [{ capability: 'text', prompt: 'volcanoes' }] };

test('provider registry selects configured provider by capability and name', () => { const registry = new GenerationProviderRegistry(); const provider = { name: 'image-a', model: 'm1', execute: async () => ({}) }; registry.register('image', provider); assert.equal(registry.get('image', 'image-a').model, 'm1'); assert.equal(registry.get('video'), null); });

test('missing provider configuration is rejected', async () => { const { worker } = makeWorker({ capability: 'image', provider: undefined }); await assert.rejects(() => worker.execute({ ...approvedTextRequest, generationRequests: [{ capability: 'image', prompt: 'x' }] }), { code: 'PROVIDER_NOT_CONFIGURED' }); });

test('successful text generation persists immutable output and provider metadata', async () => { const { worker, state } = makeWorker({ capability: 'text' }); const result = await worker.execute(approvedTextRequest, { id: 'job-1', attempts: 1 }); assert.equal(result.outputs.length, 1); assert.equal(state.artifacts[0].content, 'hello world'); assert.equal(state.transitions.at(-1).status, 'SUCCEEDED'); assert.equal(result.outputs[0].checksum.length, 64); });

test('duplicate generation is idempotent and does not invoke provider twice', async () => { let calls = 0; const { worker } = makeWorker({ provider: { name: 'test-provider', model: 'v1', execute: async () => { calls += 1; return { artifact: { content: 'stable', mediaType: 'text/plain' } }; } } }); const first = await worker.execute(approvedTextRequest, { id: 'job-1', attempts: 1 }); const second = await worker.execute(approvedTextRequest, { id: 'job-2', attempts: 1 }); assert.equal(calls, 1); assert.equal(second.outputs[0].idempotent, true); assert.equal(second.outputs[0].artifactId, first.outputs[0].artifactId); });

test('malformed provider response is terminal', async () => { const { worker } = makeWorker({ provider: { name: 'bad', execute: async () => ({}) } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'MALFORMED_PROVIDER_RESPONSE', retryable: false }); });

test('empty text output is rejected', async () => { const { worker } = makeWorker({ provider: { name: 'bad', execute: async () => ({ artifact: { content: '   ', mediaType: 'text/plain' } }) } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'INVALID_OUTPUT' }); });

test('unsupported media and corrupt image are rejected', () => { assert.throws(() => validateImage(Buffer.from('bad'), 'image/gif', { maxOutputBytes: 1000, maxImageWidth: 100, maxImageHeight: 100 }), { code: 'UNSUPPORTED_MEDIA_TYPE' }); assert.throws(() => validateImage(Buffer.from('bad'), 'image/png', { maxOutputBytes: 1000, maxImageWidth: 100, maxImageHeight: 100 }), { code: 'INVALID_OUTPUT' }); });

test('image output is validated, checksummed and persisted', async () => { const { worker, state } = makeWorker({ capability: 'image', provider: { name: 'image-a', execute: async () => ({ artifact: { contentBase64: PNG.toString('base64'), mediaType: 'image/png' } }) } }); const result = await worker.execute({ episodeId: 'ep', inputVersionIds: ['script:1'], generationRequests: [{ capability: 'image', prompt: 'diagram' }] }, { id: 'job', attempts: 1 }); assert.equal(result.outputs[0].mediaType, 'image/png'); assert.equal(state.uploads, 1); });

test('video output uses bounded media validation', async () => { const { worker } = makeWorker({ capability: 'video', provider: { name: 'video-a', execute: async () => ({ artifact: { contentBase64: PNG.toString('base64'), mediaType: 'video/mp4' } }) } }); await assert.rejects(() => worker.execute({ episodeId: 'ep', inputVersionIds: ['script:1'], generationRequests: [{ capability: 'video', prompt: 'clip' }] }, { id: 'job', attempts: 1 }), { code: 'INVALID_OUTPUT' }); });

test('provider retryable errors are surfaced with rate-limit delay metadata', async () => { const { worker } = makeWorker({ provider: { name: 'limited', execute: async () => { const error = new Error('429'); error.code = 'RATE_LIMITED'; error.retryable = true; error.details = { retryAfterMs: 4500 }; throw error; } } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'RATE_LIMITED', retryable: true }); });

test('provider timeout is classified as retryable by HTTP adapter', async () => { let calls = 0; const provider = new HttpGenerationProvider({ capability: 'text', name: 'http', endpoint: 'https://provider.invalid', timeoutMs: 5, fetchImpl: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }); await assert.rejects(() => provider.execute({ prompt: 'x' }, { timeoutMs: 5 }), { code: 'PROVIDER_TIMEOUT', retryable: true }); assert.equal(calls, 1); });

test('HTTP rate-limit response is classified and Retry-After is bounded', async () => { const provider = new HttpGenerationProvider({ capability: 'text', name: 'http', endpoint: 'https://provider.invalid', fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '10' }), body: null, text: async () => JSON.stringify({ error: 'busy' }) }) }); await assert.rejects(() => provider.execute({ prompt: 'x' }), { code: 'RATE_LIMITED', retryable: true }); assert.equal(parseRetryAfter('10') <= 60_000, true); });

test('terminal HTTP authentication errors are not retryable', async () => { const provider = new HttpGenerationProvider({ capability: 'text', name: 'http', endpoint: 'https://provider.invalid', fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), body: null, text: async () => '{}' }) }); await assert.rejects(() => provider.execute({ prompt: 'x' }), { code: 'PROVIDER_HTTP_ERROR', retryable: false }); });

test('missing approval blocks generation', async () => { const { worker } = makeWorker({ poolOverrides: { async query(sql, params = []) { if (sql.includes('SELECT 1 FROM approvals')) return { rows: [] }; if (sql.includes('SELECT id,kind,episode_id')) return { rows: [{ id: 'script:1', kind: 'script', episode_id: 'ep', content_hash: 's'.repeat(64) }] }; if (sql.includes('SELECT id,project_id,current_versions')) return { rows: [{ id: 'ep', project_id: 'project', current_versions: { script: 'script:1' } }] }; return { rows: [] }; } } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'APPROVAL_REQUIRED' }); });

test('stale script input is rejected', async () => { const { worker } = makeWorker({ poolOverrides: { async query(sql, params = []) { if (sql.includes('SELECT id,project_id,current_versions')) return { rows: [{ id: 'ep', project_id: 'project', current_versions: { script: 'script:2' } }] }; if (sql.includes('SELECT id,kind,episode_id')) return { rows: [{ id: 'script:1', kind: 'script', episode_id: 'ep', content_hash: 's'.repeat(64) }] }; if (sql.includes('SELECT 1 FROM approvals')) return { rows: [{ ok: 1 }] }; return { rows: [] }; } } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'STALE_INPUT' }); });

test('cancellation is propagated and terminal', async () => { const { worker } = makeWorker({ provider: { name: 'slow', execute: async (_request, context) => { await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(context.signal.aborted, true); throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); } }, poolOverrides: { async query(sql, params = []) { if (sql.includes('SELECT status FROM forge_jobs')) return { rows: [{ status: 'CANCELLED' }] }; return makeWorker().state ? { rows: [] } : { rows: [] }; } } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'CANCELLED' }); });

test('output checksum mismatch is rejected', async () => { const { worker } = makeWorker({ provider: { name: 'bad-checksum', execute: async () => ({ artifact: { content: 'stable', mediaType: 'text/plain', contentHash: '0'.repeat(64) } }) } }); await assert.rejects(() => worker.execute(approvedTextRequest, { id: 'job', attempts: 1 }), { code: 'CHECKSUM_MISMATCH' }); });

test('strict base64 rejects malformed binary payloads', () => { assert.throws(() => strictBase64('%%%'), { code: 'MALFORMED_PROVIDER_RESPONSE' }); });

test('generation identity changes when provider configuration changes', () => { const request = { capability: 'text', inputVersionIds: ['script:1'], prompt: 'x', parameters: {} }; const a = generationIdentity({ episodeId: 'ep', request, provider: { name: 'a', model: '1' } }); const b = generationIdentity({ episodeId: 'ep', request, provider: { name: 'b', model: '1' } }); assert.notEqual(a, b); });

test('deterministic local registry exposes all media capabilities', () => { const registry = createGenerationProviderRegistry({ config: { mode: 'deterministic' } }); assert.deepEqual(registry.list().map((item) => item.capability).sort(), ['image', 'text', 'video']); });