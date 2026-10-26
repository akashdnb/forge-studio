const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProviderRegistry } = require('../pipeline/provider-pipeline');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TEXT_CHARS = 500_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/webm', 'audio/flac']);
function fail(message, code = 'NARRATION_FAILED', retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assertNotAborted(signal) { if (signal?.aborted) throw fail('Narration job was cancelled', 'CANCELLED', false); }
function extractScriptText(payload) {
  const value = payload?.payload || payload || {};
  const candidates = [value.text, value.narration, value.scriptText, value.content?.text, value.content?.narration];
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  if (Array.isArray(value.scenes)) { const parts = value.scenes.map((scene) => scene?.narration || scene?.voiceover || scene?.text).filter((text) => typeof text === 'string' && text.trim()); if (parts.length) return parts.join('\n\n').trim(); }
  if (Array.isArray(value.paragraphs)) { const parts = value.paragraphs.filter((text) => typeof text === 'string' && text.trim()); if (parts.length) return parts.join('\n\n').trim(); }
  throw fail('Approved script does not contain narration text', 'INVALID_INPUT');
}
async function loadApprovedScript(pool, { episodeId, scriptVersionId }) {
  const episodeResult = await pool.query('SELECT id, project_id, current_versions, state FROM episodes WHERE id=$1', [episodeId]);
  const episode = episodeResult.rows[0]; if (!episode) throw fail('Episode not found', 'INVALID_PROVENANCE');
  const currentScriptId = episode.current_versions?.script; const versionId = scriptVersionId || currentScriptId;
  if (!versionId || (currentScriptId && currentScriptId !== versionId)) throw fail('Narration requires the current immutable script version', 'STALE_INPUT');
  const approval = await pool.query(`SELECT target_version_id FROM approvals WHERE episode_id=$1 AND stage='SCRIPT' AND decision='APPROVED' AND target_version_id=$2 ORDER BY decided_at DESC LIMIT 1`, [episodeId, versionId]);
  if (!approval.rows[0]) throw fail('Script version is not approved for narration', 'APPROVAL_REQUIRED');
  const result = await pool.query(`SELECT * FROM version_records WHERE id=$1 AND episode_id=$2 AND kind='script'`, [versionId, episodeId]); const script = result.rows[0];
  if (!script) throw fail('Approved script version was not found', 'INVALID_PROVENANCE'); if (!script.content_hash) throw fail('Approved script is missing its immutable content hash', 'INVALID_PROVENANCE');
  return { episode, script, text: extractScriptText(script.payload) };
}
function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env }); let stdout = Buffer.alloc(0); let stderr = ''; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { child.kill('SIGKILL'); finish(reject, fail('TTS provider was cancelled', 'CANCELLED')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, fail(`TTS provider timed out after ${timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)); }, timeoutMs); timer.unref?.(); signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > maxOutputBytes) { child.kill('SIGKILL'); finish(reject, fail('TTS provider output exceeded the configured limit', 'OUTPUT_TOO_LARGE')); } });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(reject, fail(`Unable to start TTS provider: ${error.message}`, 'PROVIDER_UNAVAILABLE', true)));
    child.on('close', (code, sig) => code === 0 ? finish(resolve, stdout) : finish(reject, fail(`TTS provider failed (${code || sig})${stderr ? `: ${stderr.trim()}` : ''}`, 'PROVIDER_FAILED', code !== 1)));
  });
}
function wavInfo(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12; let fmt = null; let dataBytes = 0;
  while (offset + 8 <= buffer.length) { const id = buffer.toString('ascii', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4); const start = offset + 8; if (id === 'fmt ' && size >= 16 && start + 16 <= buffer.length) fmt = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bitsPerSample: buffer.readUInt16LE(start + 14) }; if (id === 'data') dataBytes = size; offset = start + size + (size % 2); }
  if (!fmt || !dataBytes || fmt.codec !== 1 || !fmt.channels || !fmt.sampleRate || fmt.bitsPerSample < 8) return null; const bytesPerSample = fmt.channels * (fmt.bitsPerSample / 8);
  return { container: 'wav', codec: 'pcm', channels: fmt.channels, sampleRate: fmt.sampleRate, durationSeconds: dataBytes / (fmt.sampleRate * bytesPerSample), dataBytes, bitsPerSample: fmt.bitsPerSample };
}
async function probeAudio(buffer, contentType, { ffprobeCommand = process.env.FORGE_FFPROBE_COMMAND || 'ffprobe' } = {}) {
  const wav = wavInfo(buffer); if (wav) return wav; const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-audio-probe-')); const file = path.join(dir, 'audio.bin');
  try { await fs.writeFile(file, buffer, { flag: 'wx' }); const output = await runCommand(ffprobeCommand, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name,sample_rate,channels,codec_type', '-of', 'json', file], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 }); const parsed = JSON.parse(output.toString('utf8')); const stream = (parsed.streams || []).find((item) => item.codec_type === 'audio'); if (!stream || !parsed.format || !Number.isFinite(Number(parsed.format.duration))) throw fail('Audio probe did not find a valid audio stream', 'INVALID_OUTPUT'); const container = String(parsed.format.format_name || '').split(',')[0]; const info = { container, codec: stream.codec_name, channels: Number(stream.channels), sampleRate: Number(stream.sample_rate), durationSeconds: Number(parsed.format.duration) }; if (!ALLOWED_MEDIA_TYPES.has(String(contentType || '').toLowerCase()) && !container) throw fail('Unsupported audio media type', 'INVALID_OUTPUT'); return info; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'PROVIDER_UNAVAILABLE') throw fail('Audio is not a valid WAV and ffprobe is unavailable', 'INVALID_OUTPUT'); if (error instanceof SyntaxError) throw fail('ffprobe returned malformed output', 'INVALID_OUTPUT'); throw error; }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function validateAudio(buffer, contentType, expected = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128) throw fail('TTS provider returned empty or truncated audio', 'INVALID_OUTPUT'); if (buffer.every((byte) => byte === 0)) throw fail('TTS provider returned silent/empty content', 'INVALID_OUTPUT'); if (contentType && !ALLOWED_MEDIA_TYPES.has(contentType.toLowerCase())) throw fail(`Unsupported TTS media type: ${contentType}`, 'INVALID_OUTPUT'); if (!Number.isFinite(expected.durationSeconds) || expected.durationSeconds <= 0) throw fail('Generated audio has no positive duration', 'INVALID_OUTPUT'); if (!Number.isInteger(expected.channels) || expected.channels < 1 || expected.channels > 8) throw fail('Generated audio has invalid channel count', 'INVALID_OUTPUT'); if (!Number.isInteger(expected.sampleRate) || expected.sampleRate < 8000 || expected.sampleRate > 192000) throw fail('Generated audio has invalid sample rate', 'INVALID_OUTPUT'); return Object.freeze({ ...expected, byteLength: buffer.length, sha256: sha256(buffer) });
}
function deterministicWav(text, { sampleRate = 22050 } = {}) {
  const duration = Math.max(1, Math.min(60, Math.ceil(text.length / 18))); const samples = duration * sampleRate; const dataSize = samples * 2; const buffer = Buffer.alloc(44 + dataSize); buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40); const seed = crypto.createHash('sha256').update(text).digest(); for (let i = 0; i < samples; i += 1) { const phase = (i % sampleRate) / sampleRate; const value = Math.round(Math.sin(phase * 2 * Math.PI * (160 + (seed[i % seed.length] % 80))) * 5000); buffer.writeInt16LE(value, 44 + i * 2); } return buffer;
}
function createDeterministicProvider() { return { name: 'deterministic-local', model: 'forge-sine-v1', execute: async (request) => ({ audio: deterministicWav(request.text), contentType: 'audio/wav', metadata: { deterministic: true } }) }; }
function createCommandProvider({ command = process.env.FORGE_TTS_COMMAND, argsTemplate = process.env.FORGE_TTS_ARGS || '--input ${input} --output ${output}' } = {}) {
  if (!command) throw fail('No TTS provider configured. Set FORGE_TTS_COMMAND/FORGE_TTS_ARGS or use deterministic test mode.', 'PROVIDER_NOT_CONFIGURED');
  return { name: 'configured-tts-command', model: process.env.FORGE_TTS_MODEL || null, execute: async (request, context) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tts-')); const input = path.join(dir, 'request.json'); const output = path.join(dir, 'audio.bin'); await fs.writeFile(input, JSON.stringify({ text: request.text, voice: request.voice || null, model: request.model || null, format: request.format || null })); const args = String(argsTemplate).split(/\s+/).filter(Boolean).map((arg) => arg.replace(/\$\{(input|output)\}/g, (_, key) => ({ input, output }[key]))); try { await runCommand(command, args, { timeoutMs: context.timeoutMs, maxOutputBytes: 64 * 1024, signal: context.signal }); const audio = await fs.readFile(output); return { audio, contentType: request.format || 'audio/wav', metadata: { deterministic: false } }; } finally { await fs.rm(dir, { recursive: true, force: true }); } } };
}
function createProviderRegistry({ provider } = {}) { const registry = new ProviderRegistry(); registry.register('tts', provider || ((process.env.FORGE_TTS_MODE || '').toLowerCase() === 'deterministic' || process.env.NODE_ENV === 'test' ? createDeterministicProvider() : createCommandProvider())); return registry; }
async function executeNarration({ pool, storage, providerRegistry, payload, job, signal, timeoutMs = Number(process.env.FORGE_TTS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), maxTextChars = Number(process.env.FORGE_TTS_MAX_TEXT_CHARS || DEFAULT_MAX_TEXT_CHARS), logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required'); const episodeId = payload?.episodeId; if (!episodeId) throw fail('Narration job requires episodeId', 'INVALID_JOB'); assertNotAborted(signal);
  const { episode, script, text } = await loadApprovedScript(pool, { episodeId, scriptVersionId: payload?.scriptVersionId || payload?.inputVersionId }); if (text.length > maxTextChars) throw fail('Narration text exceeds the configured bound', 'INPUT_TOO_LARGE');
  const provider = (providerRegistry || createProviderRegistry()).get('tts'); if (!provider) throw fail('No TTS provider is registered', 'PROVIDER_NOT_CONFIGURED');
  const config = { provider: provider.name || 'unnamed', model: provider.model || null, voice: payload?.voice || process.env.FORGE_TTS_VOICE || null, format: payload?.format || 'audio/wav', speed: payload?.speed || null }; const inputFingerprint = sha256(JSON.stringify({ scriptVersionId: script.id, scriptHash: script.content_hash, text, config })); const artifactId = `narration-audio:${inputFingerprint.slice(0, 40)}`; const versionId = `narration:${inputFingerprint}`;
  const existing = await pool.query(`SELECT id, version_id, content_hash, metadata FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind='audio' LIMIT 1`, [artifactId, episodeId]); if (existing.rows[0]) { const row = existing.rows[0]; if (row.version_id !== versionId || row.metadata?.inputFingerprint !== inputFingerprint) throw fail('Existing narration artifact conflicts with the immutable idempotency identity', 'IDEMPOTENCY_CONFLICT'); return { stage: 'NARRATION', episodeId, scriptVersionId: script.id, artifactId: row.id, versionId: row.version_id, contentHash: row.content_hash, idempotent: true }; }
  const repository = new PersistentProductionRepository({ pool }); const artifactStorage = storage || new ArtifactStorageService({ storage: require('../storage').createStorageFromEnv(), repository }); assertNotAborted(signal);
  let output;
  try {
    const controller = new AbortController(); const forwardAbort = () => controller.abort(); signal?.addEventListener('abort', forwardAbort, { once: true }); let timer;
    try { const providerPromise = provider.execute(Object.freeze({ text, voice: config.voice, model: config.model, format: config.format, speed: config.speed }), { runId: job?.id || null, episodeId, stage: 'NARRATION', attempt: job?.attempt || 1, inputVersionIds: [script.id], timeoutMs, signal: controller.signal }); const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(`TTS provider timed out after ${timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)); }, timeoutMs); timer.unref?.(); }); output = await Promise.race([providerPromise, timeoutPromise]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort); }
  } catch (error) { if (error.code) throw error; throw fail(`TTS provider failed: ${error.message}`, 'PROVIDER_FAILED', Boolean(error.retryable)); }
  assertNotAborted(signal); if (!output?.audio) throw fail('TTS provider returned no audio', 'INVALID_OUTPUT'); const audio = Buffer.isBuffer(output.audio) ? output.audio : Buffer.from(output.audio, output.audioEncoding || 'base64'); const contentType = String(output.contentType || config.format || 'audio/wav').toLowerCase();
  const probed = await probeAudio(audio, contentType); const validation = validateAudio(audio, contentType, probed); assertNotAborted(signal);
  const metadata = { schemaVersion: 'forge-narration-v1', sourceScriptVersionId: script.id, sourceScriptHash: script.content_hash, inputFingerprint, provider: provider.name || 'unnamed', model: provider.model || null, voice: config.voice, durationSeconds: Number(validation.durationSeconds.toFixed(3)), container: validation.container, codec: validation.codec, sampleRate: validation.sampleRate, channels: validation.channels, sizeBytes: validation.byteLength, sha256: validation.sha256, deterministic: output.metadata?.deterministic === true, provenance: { episodeId, projectId: episode.project_id, scriptVersionId: script.id, scriptHash: script.content_hash } };
  await pool.query(`INSERT INTO version_records (id, episode_id, kind, payload, content_hash, created_by) VALUES ($1,$2,'narration',$3::jsonb,$4,$5) ON CONFLICT (episode_id,id) DO NOTHING`, [versionId, episodeId, JSON.stringify(metadata), validation.sha256, job?.created_by || 'narration-worker']);
  const content = await artifactStorage.putArtifact({ episodeId, projectId: episode.project_id, versionId, kind: 'audio', content: audio, contentType, expectedSha256: validation.sha256, metadata, artifactId, createdBy: job?.created_by || 'narration-worker', inputVersionIds: [script.id], providerRunId: job?.id || null, source: provider.name || 'tts' }); logger.log?.(`Forge narration completed for episode ${episodeId}`);
  return { stage: 'NARRATION', episodeId, scriptVersionId: script.id, artifactId: content.id, versionId: content.version_id, contentHash: content.content_hash, durationSeconds: metadata.durationSeconds, idempotent: false };
}
function createNarrationHandlers({ pool, storage, providerRegistry, ...options } = {}) { return { 'workflow:narration': (payload, job) => executeNarration({ pool, storage, providerRegistry, payload, job, ...options }) }; }
module.exports = { executeNarration, createNarrationHandlers, createProviderRegistry, createCommandProvider, createDeterministicProvider, loadApprovedScript, extractScriptText, wavInfo, validateAudio, deterministicWav, sha256 };
