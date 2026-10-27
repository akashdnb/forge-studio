const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProviderRegistry } = require('../pipeline/provider-pipeline');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { PersistentProductionRepository } = require('../persistence/production-repository');

const CAPABILITIES = Object.freeze(['image-generation', 'video-generation', 'text-generation']);
const MEDIA = Object.freeze({
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'text/plain': 'text', 'application/json': 'text', 'text/markdown': 'text',
});
const DEFAULTS = Object.freeze({
  timeoutMs: Number(process.env.FORGE_GENERATION_TIMEOUT_MS || 10 * 60 * 1000),
  maxAttempts: Number(process.env.FORGE_GENERATION_MAX_ATTEMPTS || 3),
  maxOutputBytes: Number(process.env.FORGE_GENERATION_MAX_OUTPUT_BYTES || 512 * 1024 * 1024),
  maxTextChars: Number(process.env.FORGE_GENERATION_MAX_TEXT_CHARS || 2_000_000),
  maxWidth: Number(process.env.FORGE_GENERATION_MAX_WIDTH || 16384),
  maxHeight: Number(process.env.FORGE_GENERATION_MAX_HEIGHT || 16384),
  maxDurationSeconds: Number(process.env.FORGE_GENERATION_MAX_DURATION_SECONDS || 3600),
  retryBaseMs: Number(process.env.FORGE_GENERATION_RETRY_BASE_MS || 1000),
});

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fail(message, code = 'GENERATION_FAILED', retryable = false, details = {}) { return Object.assign(new Error(message), { code, retryable, details }); }
function sleep(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) return reject(fail('Generation cancelled', 'CANCELLED')); const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(fail('Generation cancelled', 'CANCELLED')); }; signal?.addEventListener('abort', abort, { once: true }); }); }
function classifyError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').toUpperCase();
  if (code === 'CANCELLED' || code === 'ABORT_ERR') return { retryable: false, reason: 'cancelled' };
  if (code === 'PROVIDER_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') return { retryable: true, reason: 'timeout-or-network' };
  if (status === 429 || code === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS') return { retryable: true, reason: 'rate-limit', retryAfterMs: Number(error?.retryAfterMs || 0) };
  if (status >= 500 || code === 'PROVIDER_UNAVAILABLE' || code === 'UPSTREAM_5XX') return { retryable: true, reason: 'provider-unavailable' };
  return { retryable: error?.retryable === true, reason: error?.retryable ? 'provider-retryable' : 'terminal' };
}
function publicProviderMeta(provider) { return { name: provider?.name || 'unnamed', model: provider?.model || null, version: provider?.version || null }; }
function fingerprint({ capability, provider, model, request, inputVersionIds }) { return sha256(JSON.stringify({ capability, provider, model, request, inputVersionIds: [...inputVersionIds].sort() })); }
function contentBuffer(value, encoding = 'base64') {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, encoding);
  throw fail('Provider output content is not binary/string data', 'MALFORMED_PROVIDER_RESPONSE');
}
function validateText(buffer, contentType, config) {
  if (!['text/plain', 'text/markdown', 'application/json'].includes(contentType)) throw fail(`Unsupported text media type: ${contentType}`, 'UNSUPPORTED_MEDIA');
  const text = buffer.toString('utf8'); if (!text.trim()) throw fail('Provider returned empty text', 'EMPTY_OUTPUT');
  if (text.includes('\uFFFD')) throw fail('Provider returned invalid UTF-8 text', 'CORRUPT_OUTPUT');
  if (text.length > config.maxTextChars) throw fail('Generated text exceeds configured limit', 'OUTPUT_LIMIT');
  if (contentType === 'application/json') { try { JSON.parse(text); } catch { throw fail('Provider returned malformed JSON', 'CORRUPT_OUTPUT'); } }
  return { characters: text.length };
}
function validateImage(buffer, contentType, config) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw fail(`Unsupported image media type: ${contentType}`, 'UNSUPPORTED_MEDIA');
  if (buffer.length < 16) throw fail('Provider returned an empty/corrupt image', 'CORRUPT_OUTPUT');
  const signature = contentType === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : contentType === 'image/jpeg' ? buffer.subarray(0, 2).equals(Buffer.from([255,216])) : buffer.subarray(0, 4).toString('ascii') === 'RIFF';
  if (!signature) throw fail('Provider output does not match declared image format', 'CORRUPT_OUTPUT');
  const width = Number.isInteger(config.width) ? config.width : null, height = Number.isInteger(config.height) ? config.height : null;
  if ((width && width > config.maxWidth) || (height && height > config.maxHeight)) throw fail('Generated image exceeds configured dimensions', 'OUTPUT_LIMIT');
  return { width, height };
}
function validateVideo(buffer, contentType, config) {
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(contentType)) throw fail(`Unsupported video media type: ${contentType}`, 'UNSUPPORTED_MEDIA');
  if (buffer.length < 32) throw fail('Provider returned an empty/corrupt video', 'CORRUPT_OUTPUT');
  const mp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  const webm = buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!mp4 && !webm) throw fail('Provider output does not contain a supported video container signature', 'CORRUPT_OUTPUT');
  if (Number(config.durationSeconds || 0) > config.maxDurationSeconds) throw fail('Generated video exceeds configured duration', 'OUTPUT_LIMIT');
  return { durationSeconds: Number(config.durationSeconds || 0) || null };
}
function validateOutput({ content, contentType, capability, metadata = {} }, config) {
  const buffer = contentBuffer(content, metadata.encoding || 'base64');
  if (!buffer.length) throw fail('Provider returned an empty output', 'EMPTY_OUTPUT');
  if (buffer.length > config.maxOutputBytes) throw fail('Provider output exceeds configured byte limit', 'OUTPUT_LIMIT');
  const kind = MEDIA[contentType]; if (!kind) throw fail(`Unsupported provider media type: ${contentType}`, 'UNSUPPORTED_MEDIA');
  if (capability.startsWith('image') && kind !== 'image') throw fail('Image provider returned non-image output', 'MEDIA_MISMATCH');
  if (capability.startsWith('video') && kind !== 'video') throw fail('Video provider returned non-video output', 'MEDIA_MISMATCH');
  if (capability.startsWith('text') && kind !== 'text') throw fail('Text provider returned non-text output', 'MEDIA_MISMATCH');
  const validation = kind === 'text' ? validateText(buffer, contentType, config) : kind === 'image' ? validateImage(buffer, contentType, config) : validateVideo(buffer, contentType, config);
  return { buffer, validation, sha256: sha256(buffer), sizeBytes: buffer.length };
}

function createDeterministicProvider(capability) {
  return { name: 'deterministic-local', model: `forge-${capability}-v1`, execute: async (request) => {
    const seed = sha256(JSON.stringify(request));
    if (capability === 'text-generation') return { content: JSON.stringify({ generated: true, seed, prompt: request.prompt || request.text || '' }), contentType: 'application/json', metadata: { deterministic: true } };
    if (capability === 'image-generation') { const body = Buffer.from(`FORGE-DETERMINISTIC-IMAGE\n${seed}\n`); return { content: body, contentType: 'image/png', metadata: { deterministic: true, synthetic: true, format: 'test-payload' } }; }
    const body = Buffer.alloc(32); Buffer.from('FORGE-VIDEO').copy(body); Buffer.from(seed, 'hex').subarray(0, 20).copy(body, 12); return { content: body, contentType: 'video/mp4', metadata: { deterministic: true, synthetic: true, durationSeconds: 1 } };
  } };
}
function createCommandProvider({ capability, command, argsTemplate, name = 'configured-command', model = null }) {
  if (!command) throw fail(`No provider command configured for ${capability}`, 'PROVIDER_NOT_CONFIGURED');
  return { name, model, execute: async (request, context) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-generation-')); const input = path.join(dir, 'request.json'); const output = path.join(dir, 'output.bin');
    await fs.writeFile(input, JSON.stringify(request), { mode: 0o600 });
    const args = String(argsTemplate || '--input ${input} --output ${output}').split(/\s+/).filter(Boolean).map((arg) => arg.replace(/\$\{input\}/g, input).replace(/\$\{output\}/g, output));
    try { await runCommand(command, args, context); const content = await fs.readFile(output); return { content, contentType: request.contentType || (capability === 'text-generation' ? 'application/json' : capability === 'image-generation' ? 'image/png' : 'video/mp4'), metadata: { deterministic: false } }; }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  } };
}
function runCommand(command, args, { timeoutMs, signal, maxOutputBytes }) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); let settled = false; let stdoutBytes = 0; let stderr = ''; const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); }; const abort = () => { child.kill('SIGKILL'); finish(reject, fail('Provider execution cancelled', 'CANCELLED')); }; const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, fail(`Provider timed out after ${timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)); }, timeoutMs); timer.unref?.(); signal?.addEventListener('abort', abort, { once: true }); child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes > maxOutputBytes) { child.kill('SIGKILL'); finish(reject, fail('Provider stdout exceeded configured limit', 'OUTPUT_LIMIT')); } }); child.stderr.on('data', (chunk) => { if (stderr.length < 2048) stderr += chunk.toString('utf8'); }); child.on('error', (error) => finish(reject, fail('Provider process could not start', 'PROVIDER_UNAVAILABLE', true, { systemCode: error.code }))); child.on('close', (code) => code === 0 ? finish(resolve, null) : finish(reject, fail(`Provider process failed (${code})`, code === 429 ? 'RATE_LIMITED' : 'PROVIDER_FAILED', code >= 500 || code === 429, { stderr: stderr.replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s]+/gi, '$1=[REDACTED]') }))); });
}
function createGenerationProviderRegistry({ providers = {} } = {}) {
  const registry = new ProviderRegistry();
  for (const capability of CAPABILITIES) {
    const configured = providers[capability];
    const envName = capability.toUpperCase().replaceAll('-', '_');
    const provider = configured || ((process.env.FORGE_GENERATION_MODE || '').toLowerCase() === 'deterministic' || process.env.NODE_ENV === 'test' ? createDeterministicProvider(capability) : createCommandProvider({ capability, command: process.env[`FORGE_${envName}_COMMAND`], argsTemplate: process.env[`FORGE_${envName}_ARGS`], name: process.env[`FORGE_${envName}_PROVIDER`] || 'configured-command', model: process.env[`FORGE_${envName}_MODEL`] || null }));
    registry.register(capability, provider);
  }
  return registry;
}

async function loadApprovedInputs(pool, episodeId, inputVersionIds) {
  if (!episodeId || !inputVersionIds.length) throw fail('Generation requires immutable input versions', 'INVALID_INPUT');
  const episodeResult = await pool.query('SELECT id,project_id,current_versions,state FROM episodes WHERE id=$1', [episodeId]); const episode = episodeResult.rows[0]; if (!episode) throw fail('Episode not found', 'INVALID_PROVENANCE');
  const versions = await pool.query('SELECT id,kind,content_hash,payload FROM version_records WHERE episode_id=$1 AND id=ANY($2::text[])', [episodeId, inputVersionIds]); if (versions.rowCount !== inputVersionIds.length) throw fail('Generation input version is missing or belongs to another episode', 'INVALID_PROVENANCE');
  for (const id of inputVersionIds) { const approval = await pool.query(`SELECT 1 FROM approvals WHERE episode_id=$1 AND decision='APPROVED' AND target_version_id=$2 ORDER BY decided_at DESC LIMIT 1`, [episodeId, id]); if (!approval.rows[0]) throw fail(`Input version ${id} is not approved`, 'APPROVAL_BLOCKED'); const currentValues = Object.values(episode.current_versions || {}); if (currentValues.length && !currentValues.includes(id)) throw fail(`Input version ${id} is stale`, 'STALE_INPUT'); }
  return { episode, versions: versions.rows };
}

class GenerationWorker {
  constructor({ pool, storage, providerRegistry, repository, config = {}, logger = console, metrics = null } = {}) { if (!pool) throw new TypeError('pool is required'); this.pool = pool; this.repository = repository || new PersistentProductionRepository({ pool }); this.storage = storage; this.artifactStorage = storage ? new ArtifactStorageService({ storage, repository: this.repository }) : null; this.providers = providerRegistry || createGenerationProviderRegistry(); this.config = { ...DEFAULTS, ...config }; this.logger = logger; this.metrics = metrics || { increment() {} }; }
  async execute(payload = {}, job = {}) {
    const capability = payload.capability || payload.generationType || payload.type; if (!CAPABILITIES.includes(capability)) throw fail(`Unsupported generation capability: ${capability}`, 'UNSUPPORTED_CAPABILITY');
    const episodeId = payload.episodeId || job.episode_id; const inputVersionIds = [...new Set(payload.inputVersionIds || [])]; const { episode, versions } = await loadApprovedInputs(this.pool, episodeId, inputVersionIds); const provider = this.providers.get(capability); if (!provider) throw fail(`No provider configured for ${capability}`, 'PROVIDER_NOT_CONFIGURED');
    const request = Object.freeze({ prompt: payload.prompt || payload.text || '', parameters: payload.parameters || {}, contentType: payload.contentType || null, seed: payload.seed ?? null }); if (capability === 'text-generation' && !String(request.prompt).trim()) throw fail('Text generation requires a non-empty prompt', 'INVALID_INPUT');
    const inputFingerprint = fingerprint({ capability, provider: provider.name, model: provider.model || null, request, inputVersionIds }); const idempotencyKey = payload.idempotencyKey || `generation:${episodeId}:${capability}:${inputFingerprint}`; const runId = `generation:${inputFingerprint}`;
    let run = await this.repository.createProviderRun({ id: runId, episodeId, capability, provider: provider.name || 'unnamed', model: provider.model || null, inputVersionIds, idempotencyKey, request, attempt: job.attempt || 1 });
    if (run.status === 'SUCCEEDED') return { stage: 'ASSETS', capability, providerRunId: run.id, artifactIds: run.result_artifact_ids || [], versionIds: (run.result_artifact_ids || []).map(() => null).filter(Boolean), idempotent: true, metadata: run.usage || {} };
    if (run.status === 'RUNNING') throw fail('Provider run is already executing', 'IDEMPOTENCY_CONFLICT');
    await this.repository.transitionProviderRun({ id: run.id, status: 'RUNNING' });
    const controller = new AbortController(); let timer; const startedAt = Date.now();
    try {
      timer = setTimeout(() => controller.abort(), this.config.timeoutMs); timer.unref?.();
      const output = await this.#executeWithRetries(provider, request, { runId, episodeId, capability, inputVersionIds, attempt: job.attempt || 1, timeoutMs: this.config.timeoutMs, signal: controller.signal });
      if (!output || !Array.isArray(output.artifacts) || output.artifacts.length === 0) throw fail('Provider returned malformed response; expected non-empty artifacts array', 'MALFORMED_PROVIDER_RESPONSE');
      if (output.artifacts.length > 32) throw fail('Provider returned too many artifacts', 'OUTPUT_LIMIT');
      const artifactIds = [], versionIds = [];
      for (let index = 0; index < output.artifacts.length; index += 1) {
        const item = output.artifacts[index]; const contentType = String(item.contentType || '').toLowerCase(); if (!item.content) throw fail('Provider artifact is missing content', 'MALFORMED_PROVIDER_RESPONSE');
        const validated = validateOutput({ content: item.content, contentType, capability, metadata: item.metadata || {} }, { ...this.config, ...(item.metadata || {}) });
        const outputIdentity = sha256(JSON.stringify({ inputFingerprint, index, checksum: validated.sha256, contentType, role: item.role || null })); const versionId = `generated:${outputIdentity}`; const artifactId = `generated-artifact:${outputIdentity}`;
        const existing = await this.pool.query('SELECT id,version_id,content_hash FROM artifacts WHERE id=$1 AND episode_id=$2', [artifactId, episodeId]); if (existing.rows[0]) { if (existing.rows[0].version_id !== versionId || existing.rows[0].content_hash !== validated.sha256) throw fail('Generated artifact identity conflicts with immutable output', 'IDEMPOTENCY_CONFLICT'); artifactIds.push(artifactId); versionIds.push(versionId); continue; }
        await this.pool.query(`INSERT INTO version_records(id,episode_id,kind,parent_id,payload,content_hash,created_by) VALUES($1,$2,'asset',$3,$4::jsonb,$5,$6)`, [versionId, episodeId, inputVersionIds[0] || null, JSON.stringify({ schemaVersion: 'forge-generation-v1', capability, provider: publicProviderMeta(provider), inputFingerprint, inputVersionIds, checksum: validated.sha256, mediaType: contentType, validation: validated.validation }), validated.sha256, job.actor || 'generation-worker']);
        for (const inputVersionId of inputVersionIds) await this.pool.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, versionId, inputVersionId]);
        if (!this.artifactStorage) throw fail('Artifact storage is required for generation outputs', 'STORAGE_NOT_CONFIGURED');
        await this.artifactStorage.putArtifact({ episodeId, projectId: episode.projectId, versionId, artifactId, kind: item.kind || (capability === 'image-generation' ? 'image' : capability === 'video-generation' ? 'video' : 'asset'), content: validated.buffer, contentType, expectedSha256: validated.sha256, inputVersionIds, providerRunId: runId, source: provider.name || 'provider', metadata: { schemaVersion: 'forge-generation-v1', capability, provider: publicProviderMeta(provider), inputFingerprint, outputIdentity, checksum: validated.sha256, sizeBytes: validated.sizeBytes, validation: validated.validation, role: item.role || null }, createdBy: job.actor || 'generation-worker' });
        artifactIds.push(artifactId); versionIds.push(versionId);
      }
      const usage = { durationMs: Date.now() - startedAt, provider: publicProviderMeta(provider), outputCount: artifactIds.length, inputFingerprint };
      await this.repository.transitionProviderRun({ id: runId, status: 'SUCCEEDED', patch: { resultArtifactIds: artifactIds, usage, estimatedCost: output.estimatedCost ?? null, actualCost: output.actualCost ?? null, currency: output.currency || 'USD' } });
      this.metrics.increment('forge_generation_success', { capability, provider: provider.name || 'unnamed' });
      return { stage: 'ASSETS', capability, providerRunId: runId, artifactIds, versionIds, usageAccounting: { durationMs: usage.durationMs, outputCount: artifactIds.length }, metadata: usage };
    } catch (error) {
      const classification = classifyError(error); const safeError = { code: error.code || 'GENERATION_FAILED', message: error.message, retryable: classification.retryable, reason: classification.reason };
      await this.repository.transitionProviderRun({ id: runId, status: classification.retryable ? 'FAILED' : 'FAILED', patch: { error: safeError } }).catch(() => {}); this.metrics.increment('forge_generation_failure', { capability, provider: provider.name || 'unnamed', reason: classification.reason }); throw Object.assign(error, { retryable: classification.retryable });
    } finally { clearTimeout(timer); }
  }
  async #executeWithRetries(provider, request, context) {
    let lastError; for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) { try { if (context.signal.aborted) throw fail('Generation cancelled', 'CANCELLED'); return await Promise.race([provider.execute(request, { ...context, attempt }), new Promise((_, reject) => setTimeout(() => reject(fail(`Provider timed out after ${this.config.timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)), this.config.timeoutMs))]); } catch (error) { lastError = error; const classification = classifyError(error); if (!classification.retryable || attempt >= this.config.maxAttempts) break; const delay = classification.retryAfterMs > 0 ? Math.min(classification.retryAfterMs, 60_000) : Math.min(this.config.retryBaseMs * 2 ** (attempt - 1), 60_000); this.metrics.increment('forge_generation_retry', { capability: context.capability, reason: classification.reason }); await sleep(delay, context.signal); } } throw lastError; }
}
function createGenerationJobHandler({ pool, storage, providerRegistry, config, logger, metrics } = {}) { const worker = new GenerationWorker({ pool, storage, providerRegistry, config, logger, metrics }); return (payload, job) => worker.execute(payload, job); }
module.exports = { CAPABILITIES, DEFAULTS, GenerationWorker, createGenerationProviderRegistry, createGenerationJobHandler, classifyError, validateOutput, sha256, loadApprovedInputs };
