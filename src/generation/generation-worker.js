const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const { createGenerationProviderRegistry, CAPABILITIES } = require('./provider-registry');

const DEFAULTS = Object.freeze({
  timeoutMs: Number(process.env.FORGE_GENERATION_TIMEOUT_MS || 600_000),
  maxAttempts: Number(process.env.FORGE_GENERATION_MAX_ATTEMPTS || 3),
  maxRequests: Number(process.env.FORGE_GENERATION_MAX_REQUESTS || 50),
  maxTextChars: Number(process.env.FORGE_GENERATION_MAX_TEXT_CHARS || 1_000_000),
  maxOutputBytes: Number(process.env.FORGE_GENERATION_MAX_OUTPUT_BYTES || 1_073_741_824),
  maxImageWidth: Number(process.env.FORGE_GENERATION_MAX_IMAGE_WIDTH || 16384),
  maxImageHeight: Number(process.env.FORGE_GENERATION_MAX_IMAGE_HEIGHT || 16384),
  maxVideoDurationSeconds: Number(process.env.FORGE_GENERATION_MAX_VIDEO_DURATION_SECONDS || 3600),
  maxVideoWidth: Number(process.env.FORGE_GENERATION_MAX_VIDEO_WIDTH || 16384),
  maxVideoHeight: Number(process.env.FORGE_GENERATION_MAX_VIDEO_HEIGHT || 16384),
  ffprobeCommand: process.env.FORGE_FFPROBE_COMMAND || 'ffprobe',
});

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const APPROVAL_BY_KIND = Object.freeze({ script: 'SCRIPT', 'scene-plan': 'SCENE_PLAN', scene: 'SCENE_PLAN' });

function fail(message, code = 'GENERATION_FAILED', retryable = false, details = {}) {
  return Object.assign(new Error(message), { code, retryable, details });
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) { return JSON.stringify(value, Object.keys(value || {}).sort()); }
function assertNotAborted(signal) { if (signal?.aborted) throw fail('Generation job was cancelled', 'CANCELLED'); }

function strictBase64(value) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail('Provider returned invalid base64 content', 'MALFORMED_PROVIDER_RESPONSE');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== value) throw fail('Provider returned invalid base64 content', 'MALFORMED_PROVIDER_RESPONSE');
  return buffer;
}

function parsePng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]; offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5), format: 'jpeg' };
    offset += length;
  }
  return null;
}

function parseWebp(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), format: 'webp' };
  return { width: null, height: null, format: 'webp' };
}

function validateImage(buffer, mediaType, config) {
  if (!IMAGE_TYPES.has(mediaType)) throw fail(`Unsupported generated image media type: ${mediaType}`, 'UNSUPPORTED_MEDIA_TYPE');
  if (!buffer.length || buffer.length > config.maxOutputBytes) throw fail('Generated image is empty or exceeds the configured output limit', 'OUTPUT_LIMIT');
  const info = parsePng(buffer) || parseJpeg(buffer) || parseWebp(buffer);
  if (!info) throw fail('Generated image is malformed or corrupt', 'INVALID_OUTPUT');
  if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width < 1 || info.height < 1) throw fail('Generated image dimensions are invalid', 'INVALID_OUTPUT');
  if (info.width > config.maxImageWidth || info.height > config.maxImageHeight) throw fail('Generated image dimensions exceed configured limits', 'OUTPUT_LIMIT', false, { width: info.width, height: info.height });
  return { mediaType, width: info.width, height: info.height, sizeBytes: buffer.length, checksum: sha256(buffer) };
}

function runProbe(command, args, { timeoutMs, signal, maxOutputBytes = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = Buffer.alloc(0); let stderr = ''; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => { child.kill('SIGKILL'); finish(reject, fail('Video validation was cancelled', 'CANCELLED')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, fail(`ffprobe timed out after ${timeoutMs}ms`, 'VALIDATION_TIMEOUT', true)); }, timeoutMs); timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > maxOutputBytes) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(reject, fail(`Unable to run ffprobe: ${error.message}`, 'VALIDATION_UNAVAILABLE', true)));
    child.on('close', (code) => code === 0 ? finish(resolve, stdout) : finish(reject, fail(`ffprobe rejected generated video${stderr ? `: ${stderr.trim()}` : ''}`, 'INVALID_OUTPUT')));
  });
}

async function validateVideo(buffer, mediaType, config, { probeImpl, signal } = {}) {
  if (!VIDEO_TYPES.has(mediaType)) throw fail(`Unsupported generated video media type: ${mediaType}`, 'UNSUPPORTED_MEDIA_TYPE');
  if (!buffer.length || buffer.length > config.maxOutputBytes) throw fail('Generated video is empty or exceeds the configured output limit', 'OUTPUT_LIMIT');
  let probe;
  if (probeImpl) probe = await probeImpl(buffer, { mediaType, signal });
  else {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-generation-video-'));
    const file = path.join(dir, 'output.bin');
    try { await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o600 }); const output = await runProbe(config.ffprobeCommand, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,width,height,codec_name', '-of', 'json', file], { timeoutMs: config.timeoutMs, signal }); try { probe = JSON.parse(output.toString('utf8')); } catch { throw fail('ffprobe returned malformed JSON', 'INVALID_OUTPUT'); } }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  const stream = (probe?.streams || []).find((item) => item.codec_type === 'video');
  const duration = Number(probe?.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw fail('Generated video has no valid video stream or duration', 'INVALID_OUTPUT');
  const width = Number(stream.width), height = Number(stream.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw fail('Generated video dimensions are invalid', 'INVALID_OUTPUT');
  if (duration > config.maxVideoDurationSeconds || width > config.maxVideoWidth || height > config.maxVideoHeight) throw fail('Generated video exceeds configured media limits', 'OUTPUT_LIMIT', false, { durationSeconds: duration, width, height });
  if (!stream.codec_name) throw fail('Generated video codec is missing', 'INVALID_OUTPUT');
  return { mediaType, width, height, durationSeconds: Number(duration.toFixed(3)), codec: stream.codec_name, sizeBytes: buffer.length, checksum: sha256(buffer) };
}

function validateText(content, config) {
  if (typeof content !== 'string' || !content.trim()) throw fail('Generated text is empty', 'INVALID_OUTPUT');
  const value = content.trim();
  if (value.length > config.maxTextChars || Buffer.byteLength(value, 'utf8') > config.maxOutputBytes) throw fail('Generated text exceeds configured output limits', 'OUTPUT_LIMIT');
  return { mediaType: 'text/plain', charCount: value.length, sizeBytes: Buffer.byteLength(value), checksum: sha256(Buffer.from(value)) };
}

async function loadApprovedInputs(pool, episodeId, inputVersionIds) {
  if (!episodeId || !inputVersionIds.length) throw fail('Generation requires immutable approved input versions', 'INVALID_PROVENANCE');
  const episodeResult = await pool.query('SELECT id,project_id,current_versions FROM episodes WHERE id=$1', [episodeId]);
  const episode = episodeResult.rows[0]; if (!episode) throw fail('Episode not found', 'NOT_FOUND');
  const result = await pool.query('SELECT id,kind,episode_id,content_hash,payload FROM version_records WHERE episode_id=$1 AND id=ANY($2::text[])', [episodeId, inputVersionIds]);
  if (result.rowCount !== inputVersionIds.length) throw fail('One or more generation inputs are not part of the episode', 'INVALID_PROVENANCE');
  for (const version of result.rows) {
    const approvalStage = APPROVAL_BY_KIND[version.kind];
    if (!approvalStage) throw fail(`Generation input kind is not approved for generation: ${version.kind}`, 'INVALID_PROVENANCE');
    const approval = await pool.query('SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND decision=\'APPROVED\' AND target_version_id=$3 ORDER BY decided_at DESC LIMIT 1', [episodeId, approvalStage, version.id]);
    if (!approval.rows[0]) throw fail(`Generation input ${version.id} is not approved`, 'APPROVAL_REQUIRED');
    const currentKey = version.kind === 'scene-plan' ? 'scene_plan' : version.kind;
    if (episode.current_versions?.[currentKey] && episode.current_versions[currentKey] !== version.id) throw fail(`Generation input ${version.id} is stale`, 'STALE_INPUT');
    if (!version.content_hash) throw fail(`Generation input ${version.id} has no immutable checksum`, 'INVALID_PROVENANCE');
  }
  return { episode, versions: result.rows };
}

function normalizeRequest(request, fallbackInputVersionIds) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('Generation request must be an object', 'INVALID_INPUT');
  const capability = String(request.capability || '').toLowerCase();
  if (!CAPABILITIES.includes(capability)) throw fail(`Unsupported generation capability: ${capability}`, 'INVALID_INPUT');
  const inputVersionIds = [...new Set(request.inputVersionIds || fallbackInputVersionIds || [])];
  if (!inputVersionIds.length) throw fail('Generation request requires inputVersionIds', 'INVALID_PROVENANCE');
  return { capability, inputVersionIds, prompt: request.prompt, text: request.text, parameters: request.parameters || {}, provider: request.provider || null, metadata: request.metadata || {} };
}

function generationIdentity({ episodeId, request, provider }) {
  return sha256(canonical({ contract: 'forge-generation-v1', episodeId, capability: request.capability, inputVersionIds: [...request.inputVersionIds].sort(), prompt: request.prompt || null, text: request.text || null, parameters: request.parameters, provider: provider.name || 'unnamed', model: provider.model || null }));
}

function extractSceneGenerationRequests(scenePlan) {
  const requests = [];
  for (const scene of scenePlan?.scenes || []) {
    const configured = scene?.visual?.generationRequests ?? scene?.visual?.generation;
    const list = Array.isArray(configured) ? configured : configured ? [configured] : [];
    for (const request of list) requests.push({ ...request, metadata: { ...(request.metadata || {}), sceneId: scene.id, assetRole: request.assetRole || scene.type } });
  }
  return requests;
}

class GenerationWorker {
  constructor({ repository, storage, providerRegistry, config = {}, probeVideo, logger = console } = {}) {
    if (!repository?.db?.pool) throw new TypeError('repository with db.pool is required');
    this.repository = repository;
    this.storageService = storage instanceof ArtifactStorageService ? storage : new ArtifactStorageService({ storage, repository });
    this.providers = providerRegistry || createGenerationProviderRegistry({ config });
    this.config = { ...DEFAULTS, ...config };
    if (!Number.isInteger(this.config.maxAttempts) || this.config.maxAttempts < 1 || this.config.maxAttempts > 5) throw new TypeError('maxAttempts must be 1..5');
    this.probeVideo = probeVideo;
    this.logger = logger;
  }

  async execute(payload = {}, job = {}) {
    const episodeId = payload.episodeId || job.episode_id;
    if (!episodeId) throw fail('Generation job requires episodeId', 'INVALID_JOB');
    const controller = new AbortController();
    const cancelWatcher = this.#watchCancellation(job.id, controller);
    try {
      assertNotAborted(controller.signal);
      const inputVersionIds = [...new Set(payload.inputVersionIds || [])];
      let requests = Array.isArray(payload.generationRequests) ? payload.generationRequests : null;
      if (!requests) requests = await this.#deriveRequests(episodeId, inputVersionIds);
      if (!requests.length) throw fail('Generation job contains no generation requests', 'INVALID_INPUT');
      if (requests.length > this.config.maxRequests) throw fail(`Generation request count exceeds ${this.config.maxRequests}`, 'OUTPUT_LIMIT');
      const outputs = [];
      for (const rawRequest of requests) {
        assertNotAborted(controller.signal);
        const request = normalizeRequest(rawRequest, inputVersionIds);
        const inputs = await loadApprovedInputs(this.repository.db.pool, episodeId, request.inputVersionIds);
        const provider = this.providers.get(request.capability, request.provider);
        if (!provider) throw fail(`No configured provider for generation capability ${request.capability}${request.provider ? ` (${request.provider})` : ''}`, 'PROVIDER_NOT_CONFIGURED');
        const identity = generationIdentity({ episodeId, request, provider });
        const result = await this.#executeOne({ episodeId, projectId: inputs.episode.project_id, request, provider, identity, inputs, job, signal: controller.signal });
        outputs.push(result);
      }
      return { stage: 'GENERATION', episodeId, outputs, artifactIds: outputs.map((output) => output.artifactId), versionIds: outputs.map((output) => output.versionId), deterministic: outputs.every((output) => output.deterministic) };
    } finally {
      clearInterval(cancelWatcher);
    }
  }

  async #executeOne({ episodeId, projectId, request, provider, identity, inputs, job, signal }) {
    const runId = `generation-run:${identity}`;
    const idempotencyKey = `generation:${identity}`;
    const versionId = `generation:${identity}`;
    const artifactId = `generation-artifact:${identity}`;
    let run = await this.repository.createProviderRun({ id: runId, episodeId, capability: request.capability, provider: provider.name || 'unnamed', model: provider.model || null, inputVersionIds: request.inputVersionIds, idempotencyKey, request: { ...request, metadata: undefined }, attempt: job.attempts || 1 });
    if (run.status === 'SUCCEEDED') {
      const artifactIds = run.result_artifact_ids || run.resultArtifactIds || [];
      if (artifactIds.length) return { artifactId: artifactIds[0], versionId, providerRunId: run.id, idempotent: true, deterministic: provider.name === 'deterministic-local' };
      throw fail('Succeeded generation run has no output artifacts', 'INVALID_PROVENANCE');
    }
    if (run.status === 'RUNNING') throw fail('Generation provider run is already running', 'IDEMPOTENCY_CONFLICT');
    if (run.status === 'FAILED' || run.status === 'CANCELLED') throw fail(`Generation provider run is already ${run.status}`, 'IDEMPOTENCY_CONFLICT');
    run = await this.repository.transitionProviderRun({ id: run.id, status: 'RUNNING' });
    try {
      const output = await provider.execute(Object.freeze({ prompt: request.prompt, text: request.text, parameters: request.parameters }), { runId: run.id, episodeId, capability: request.capability, attempt: job.attempts || 1, inputVersionIds: request.inputVersionIds, idempotencyKey, timeoutMs: this.config.timeoutMs, signal });
      assertNotAborted(signal);
      const normalized = await this.#validateOutput(output, request.capability, signal);
      const metadata = { schemaVersion: 'forge-generation-v1', immutable: true, provider: provider.name || 'unnamed', model: provider.model || null, inputVersionIds: request.inputVersionIds, inputChecksums: Object.fromEntries(inputs.versions.map((version) => [version.id, version.content_hash])), generationIdentity: identity, providerMetadata: sanitizeProviderMetadata(output?.metadata || {}), requestMetadata: request.metadata, validation: normalized.validation, deterministic: provider.name === 'deterministic-local' };
      const existingVersion = await this.repository.db.pool.query('SELECT id,episode_id,kind,content_hash FROM version_records WHERE id=$1', [versionId]);
      if (!existingVersion.rows[0]) await this.repository.db.pool.query('INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [versionId, episodeId, request.capability === 'text' ? 'generated-text' : 'generated-media', JSON.stringify({ capability: request.capability, provider: provider.name || 'unnamed', metadata }), normalized.checksum, job.payload?.actor || 'worker']);
      else if (existingVersion.rows[0].episode_id !== episodeId || existingVersion.rows[0].content_hash !== normalized.checksum) throw fail('Immutable generation version identity conflicts with an existing output', 'IDEMPOTENCY_CONFLICT');
      for (const dependency of request.inputVersionIds) await this.repository.db.pool.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, versionId, dependency]);
      let artifact;
      if (request.capability === 'text') {
        artifact = await this.repository.registerArtifact({ id: artifactId, episodeId, kind: 'package', versionId, content: normalized.content, contentHash: normalized.checksum, mediaType: 'text/plain', providerRunId: run.id, source: 'generation', inputVersionIds: request.inputVersionIds, metadata, createdBy: job.payload?.actor || 'worker' });
      } else {
        artifact = await this.storageService.putArtifact({ episodeId, projectId, versionId, artifactId, kind: request.capability, content: normalized.content, contentType: normalized.mediaType, expectedSha256: normalized.checksum, providerRunId: run.id, source: 'generation', inputVersionIds: request.inputVersionIds, metadata, createdBy: job.payload?.actor || 'worker' });
      }
      const finalRun = await this.repository.transitionProviderRun({ id: run.id, status: 'SUCCEEDED', patch: { resultArtifactIds: [artifact.id], usage: sanitizeUsage(output?.usage), estimatedCost: output?.estimatedCost ?? null, actualCost: output?.actualCost ?? null, currency: output?.currency || 'USD' } });
      return { artifactId: artifact.id, versionId, providerRunId: finalRun.id, checksum: normalized.checksum, mediaType: normalized.mediaType, validation: normalized.validation, deterministic: provider.name === 'deterministic-local', idempotent: false };
    } catch (error) {
      const safeError = sanitizeError(error);
      await this.repository.transitionProviderRun({ id: run.id, status: 'FAILED', patch: { error: safeError } }).catch(() => {});
      throw error;
    }
  }

  async #validateOutput(output, capability, signal) {
    if (!output || typeof output !== 'object' || !output.artifact || typeof output.artifact !== 'object') throw fail('Provider response must contain an artifact object', 'MALFORMED_PROVIDER_RESPONSE');
    const artifact = output.artifact;
    assertNotAborted(signal);
    if (typeof artifact.contentBase64 === 'string') {
      const content = strictBase64(artifact.contentBase64);
      if (content.length > this.config.maxOutputBytes) throw fail('Generated output exceeds configured output limit', 'OUTPUT_LIMIT');
      const mediaType = String(artifact.mediaType || '').toLowerCase();
      const validation = capability === 'image' ? validateImage(content, mediaType, this.config) : await validateVideo(content, mediaType, this.config, { probeImpl: this.probeVideo, signal });
      if (artifact.contentHash && artifact.contentHash !== validation.checksum) throw fail('Provider output checksum does not match generated bytes', 'CHECKSUM_MISMATCH');
      return { content, mediaType, checksum: validation.checksum, validation };
    }
    if (capability !== 'text' || typeof artifact.content !== 'string') throw fail('Provider response contains no supported output content', 'MALFORMED_PROVIDER_RESPONSE');
    const content = artifact.content.trim();
    const validation = validateText(content, this.config);
    if (artifact.contentHash && artifact.contentHash !== validation.checksum) throw fail('Provider output checksum does not match generated text', 'CHECKSUM_MISMATCH');
    return { content, mediaType: 'text/plain', checksum: validation.checksum, validation };
  }

  async #deriveRequests(episodeId, inputVersionIds) {
    if (!inputVersionIds.length) throw fail('Generation requires an approved scene-plan input when requests are omitted', 'INVALID_PROVENANCE');
    const result = await this.repository.db.pool.query('SELECT payload FROM version_records WHERE id=$1 AND episode_id=$2 AND kind=\'scene-plan\'', [inputVersionIds[0], episodeId]);
    if (!result.rows[0]) throw fail('Generation request source must be an approved scene-plan version', 'INVALID_PROVENANCE');
    return extractSceneGenerationRequests(result.rows[0].payload);
  }

  #watchCancellation(jobId, controller) {
    if (!jobId) return setInterval(() => {}, 2_147_483_647);
    const timer = setInterval(async () => {
      if (controller.signal.aborted) return;
      try { const row = await this.repository.db.pool.query('SELECT status FROM forge_jobs WHERE id=$1', [jobId]); if (row.rows[0]?.status === 'CANCELLED') controller.abort(); }
      catch (error) { this.logger.warn?.('Generation cancellation poll failed', error.message); }
    }, 500);
    timer.unref?.();
    return timer;
  }
}

function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) if (/^[a-zA-Z0-9_.-]{1,64}$/.test(key) && (typeof item === 'number' || typeof item === 'string')) result[key] = item;
  return result;
}

function sanitizeProviderMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|authorization|api[-_]?key|password|credential/i.test(key)) continue;
    if (typeof item === 'string' && item.length > 1024) continue;
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) result[key] = item;
  }
  return result;
}

function sanitizeError(error) {
  return { code: error?.code || 'GENERATION_FAILED', message: String(error?.message || 'Generation failed').slice(0, 500), retryable: error?.retryable === true, retryAfterMs: Number.isFinite(error?.details?.retryAfterMs) ? Math.min(60_000, Math.max(0, error.details.retryAfterMs)) : null };
}

function createGenerationHandlers({ pool, storage, config = {}, providerRegistry, probeVideo, logger = console, fallbackAssetsHandler = null } = {}) {
  const repository = new PersistentProductionRepository({ pool });
  const worker = new GenerationWorker({ repository, storage, config, providerRegistry, probeVideo, logger });
  const execute = (payload, job) => worker.execute(payload, job);
  const handlers = Object.fromEntries(CAPABILITIES.map((capability) => [`generation:${capability}`, (payload, job) => worker.execute({ ...payload, generationRequests: [{ ...(payload.request || payload), capability }] }, job)]));
  handlers['workflow:generation'] = execute;
  handlers['workflow:assets'] = async (payload, job) => {
    if (Array.isArray(payload?.generationRequests) || process.env.FORGE_GENERATION_ASSETS_MODE === 'generation') return execute(payload, job);
    return fallbackAssetsHandler ? fallbackAssetsHandler(payload, job) : execute(payload, job);
  };
  return handlers;
}

module.exports = {
  DEFAULTS,
  GenerationWorker,
  createGenerationHandlers,
  validateImage,
  validateVideo,
  validateText,
  loadApprovedInputs,
  generationIdentity,
  extractSceneGenerationRequests,
  strictBase64,
};