const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PersistentProductionRepository } = require('../persistence/production-repository');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const AUDIO_MEDIA_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/x-m4a']);

function fail(message, code = 'TRANSCRIPTION_FAILED', retryable = false) { return Object.assign(new Error(message), { code, retryable }); }

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(filePath);
    stream.on('error', reject); stream.on('data', (chunk) => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadImmutableInput(uri, destination, { expectedSha256, maxBytes = DEFAULT_MAX_INPUT_BYTES, fetchImpl = fetch } = {}) {
  if (!uri || typeof uri !== 'string') throw fail('Narration artifact has no storageUri', 'INVALID_INPUT');
  if (uri.startsWith('file://')) {
    if (process.env.FORGE_TRANSCRIPTION_ALLOW_FILE !== 'true') throw fail('file:// input is disabled; use immutable HTTPS storage in production', 'INSECURE_INPUT');
    const source = new URL(uri); const stat = await fsp.stat(source);
    if (!stat.isFile() || stat.size > maxBytes) throw fail('Input file is missing or exceeds the configured size limit', 'INPUT_TOO_LARGE');
    await fsp.copyFile(source, destination);
  } else {
    let parsed; try { parsed = new URL(uri); } catch { throw fail('storageUri must be an absolute HTTPS URL', 'INVALID_INPUT'); }
    if (parsed.protocol !== 'https:') throw fail('Only HTTPS artifact downloads are permitted', 'INSECURE_INPUT');
    const response = await fetchImpl(uri, { redirect: 'error' });
    if (!response.ok || !response.body) throw fail(`Artifact download failed with HTTP ${response.status}`, 'INPUT_DOWNLOAD_FAILED', response.status >= 500);
    const length = Number(response.headers.get('content-length') || 0);
    if (length && length > maxBytes) throw fail('Artifact exceeds configured input size limit', 'INPUT_TOO_LARGE');
    const file = fs.createWriteStream(destination, { flags: 'wx' }); let bytes = 0;
    try {
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw fail('Artifact exceeds configured input size limit', 'INPUT_TOO_LARGE'); if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve)); }
      await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
    } catch (error) { file.destroy(); throw error; }
  }
  const actual = await sha256File(destination);
  if (!expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw fail('Immutable narration artifact must include a SHA-256 content hash', 'INVALID_PROVENANCE');
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedSha256.toLowerCase(), 'hex'))) throw fail('Narration artifact checksum mismatch', 'CHECKSUM_MISMATCH');
  return { sha256: actual, sizeBytes: (await fsp.stat(destination)).size };
}

function parseWhisperSegments(raw) {
  if (!raw || typeof raw !== 'object') throw fail('Whisper provider returned no JSON object', 'PROVIDER_OUTPUT_INVALID');
  const source = Array.isArray(raw.segments) ? raw.segments : Array.isArray(raw.results) ? raw.results : null;
  if (!source) throw fail('Whisper provider output must contain segments[]', 'PROVIDER_OUTPUT_INVALID');
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : null;
  if (!language) throw fail('Whisper provider output must contain language', 'PROVIDER_OUTPUT_INVALID');
  const segments = source.map((segment, index) => {
    const start = Number(segment.start); const end = Number(segment.end); const text = String(segment.text || '').trim();
    const confidence = segment.confidence == null ? (segment.avg_logprob == null ? null : Math.max(0, Math.min(1, Math.exp(Number(segment.avg_logprob))))) : Number(segment.confidence);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || !text) throw fail(`Invalid Whisper segment at index ${index}`, 'PROVIDER_OUTPUT_INVALID');
    if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw fail(`Invalid confidence at segment ${index}`, 'PROVIDER_OUTPUT_INVALID');
    return { index, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text, confidence: confidence == null ? null : Number(confidence.toFixed(6)) };
  });
  for (let i = 1; i < segments.length; i += 1) if (segments[i].start < segments[i - 1].start || segments[i].end < segments[i - 1].end) throw fail('Whisper segments are not ordered', 'PROVIDER_OUTPUT_INVALID');
  return { language, segments, durationSeconds: Number((segments.length ? segments[segments.length - 1].end : 0).toFixed(3)) };
}

function runCommand(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env });
    let stdout = ''; let stderr = ''; let bytes = 0; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, fail(`Whisper command timed out after ${timeoutMs}ms`, 'PROVIDER_TIMEOUT', true)); }, timeoutMs); timer.unref?.();
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxOutputBytes) { child.kill('SIGKILL'); finish(reject, fail('Whisper output exceeded configured limit', 'OUTPUT_TOO_LARGE')); } else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 16384) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(reject, fail(`Unable to start Whisper command: ${error.message}`, 'PROVIDER_UNAVAILABLE')));
    child.on('close', (code, signal) => code === 0 ? finish(resolve, stdout) : finish(reject, fail(`Whisper command failed (${code || signal}): ${stderr.trim() || 'no stderr'}`, 'PROVIDER_FAILED', false)));
  });
}

async function transcribeWithWhisper(inputPath, { timeoutMs, maxOutputBytes, command = process.env.FORGE_WHISPER_COMMAND, argsTemplate = process.env.FORGE_WHISPER_ARGS } = {}) {
  if (!command) throw fail('No Whisper provider configured. Set FORGE_WHISPER_COMMAND and FORGE_WHISPER_ARGS.', 'PROVIDER_NOT_CONFIGURED');
  const args = String(argsTemplate || '--model ${model} --output_format json --output_dir ${outDir} ${input}').split(/\s+/).filter(Boolean);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-whisper-out-')); const model = process.env.FORGE_WHISPER_MODEL || '';
  const substitutions = { input: inputPath, outDir, model };
  const rendered = args.map((arg) => arg.replace(/\$\{(input|outDir|model)\}/g, (_, key) => substitutions[key]));
  try {
    const stdout = await runCommand(command, rendered, { cwd: outDir, timeoutMs, maxOutputBytes });
    const jsonFiles = (await fsp.readdir(outDir)).filter((name) => name.toLowerCase().endsWith('.json'));
    const raw = jsonFiles.length ? JSON.parse(await fsp.readFile(path.join(outDir, jsonFiles.sort()[0]), 'utf8')) : JSON.parse(stdout);
    return parseWhisperSegments(raw);
  } catch (error) { if (error instanceof SyntaxError) throw fail('Whisper provider returned invalid JSON', 'PROVIDER_OUTPUT_INVALID'); throw error; }
  finally { await fsp.rm(outDir, { recursive: true, force: true }); }
}

async function loadApprovedNarration(pool, { episodeId, artifactId, versionId }) {
  let result;
  if (artifactId && versionId) {
    result = await pool.query(`SELECT a.*, e.project_id, e.current_versions, e.state FROM artifacts a JOIN episodes e ON e.id=a.episode_id WHERE a.id=$1 AND a.episode_id=$2 AND a.version_id=$3 AND a.kind='narration'`, [artifactId, episodeId, versionId]);
  } else {
    result = await pool.query(`SELECT a.*, e.project_id, e.current_versions, e.state FROM artifacts a JOIN episodes e ON e.id=a.episode_id WHERE a.episode_id=$1 AND a.kind='narration' AND (e.current_versions->>'narration'=a.version_id OR e.current_versions->>'narration' IS NULL) ORDER BY a.created_at DESC LIMIT 1`, [episodeId]);
  }
  const artifact = result.rows[0];
  if (!artifact) throw fail('Approved narration/audio artifact was not found for the supplied episode/version', 'INVALID_PROVENANCE');
  const currentNarration = artifact.current_versions?.narration;
  if (currentNarration && currentNarration !== artifact.version_id) throw fail('Narration artifact is stale; only the current immutable narration version may be transcribed', 'STALE_INPUT');
  if (artifact.metadata?.approved !== true) throw fail('Narration artifact is not approved for transcription; set metadata.approved=true after the approval gate', 'APPROVAL_REQUIRED');
  if (!artifact.storage_uri) throw fail('Approved narration artifact must have a storageUri', 'INVALID_INPUT');
  if (!artifact.content_hash) throw fail('Approved narration artifact must have a SHA-256 checksum', 'INVALID_PROVENANCE');
  if (artifact.media_type && !AUDIO_MEDIA_TYPES.has(String(artifact.media_type).toLowerCase())) throw fail(`Narration artifact media type is not audio: ${artifact.media_type}`, 'INVALID_INPUT');
  return artifact;
}

async function executeTranscription({ pool, payload, job, fetchImpl = fetch, timeoutMs = Number(process.env.FORGE_TRANSCRIPTION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), maxInputBytes = Number(process.env.FORGE_TRANSCRIPTION_MAX_INPUT_BYTES || DEFAULT_MAX_INPUT_BYTES), maxOutputBytes = Number(process.env.FORGE_TRANSCRIPTION_MAX_OUTPUT_BYTES || DEFAULT_MAX_OUTPUT_BYTES), logger = console } = {}) {
  if (!pool) throw new TypeError('pool is required');
  const episodeId = payload?.episodeId;
  if (!episodeId) throw fail('Transcription job requires episodeId', 'INVALID_JOB');
  const narration = await loadApprovedNarration(pool, { episodeId, artifactId: payload?.narrationArtifactId || payload?.inputArtifactId, versionId: payload?.narrationVersionId || payload?.inputVersionId });
  const artifactId = narration.id; const versionId = narration.version_id;
  const repository = new PersistentProductionRepository({ pool });
  const existing = await pool.query('SELECT a.id, a.version_id FROM artifacts a WHERE a.episode_id=$1 AND a.kind=\'transcript\' AND a.metadata->>\'sourceArtifactId\'=$2 AND a.metadata->>\'sourceVersionId\'=$3 LIMIT 1', [episodeId, artifactId, versionId]);
  if (existing.rows[0]) return { stage: 'TRANSCRIPTION', episodeId, inputArtifactId: artifactId, inputVersionId: versionId, artifactId: existing.rows[0].id, versionId: existing.rows[0].version_id, idempotent: true };
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-transcription-')); const inputPath = path.join(workDir, 'narration.audio');
  try {
    const input = await downloadImmutableInput(narration.storage_uri, inputPath, { expectedSha256: narration.content_hash, maxBytes: maxInputBytes, fetchImpl });
    const transcript = await transcribeWithWhisper(inputPath, { timeoutMs, maxOutputBytes });
    const content = { schemaVersion: 'forge-transcript-v1', language: transcript.language, durationSeconds: transcript.durationSeconds, segments: transcript.segments };
    const contentHash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const transcriptVersionId = `transcript:${crypto.createHash('sha256').update(`${episodeId}:${versionId}:${contentHash}`).digest('hex')}`;
    const transcriptArtifactId = `transcript-artifact:${crypto.createHash('sha256').update(`${episodeId}:${versionId}:${contentHash}`).digest('hex').slice(0, 40)}`;
    await repository.db.withTransaction(async (client) => {
      const again = await client.query('SELECT id, version_id FROM artifacts WHERE id=$1 OR (episode_id=$2 AND kind=\'transcript\' AND metadata->>\'sourceArtifactId\'=$3 AND metadata->>\'sourceVersionId\'=$4) LIMIT 1', [transcriptArtifactId, episodeId, artifactId, versionId]);
      if (again.rows[0]) return;
      await client.query('INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,\'transcript\',$3::jsonb,$4,$5)', [transcriptVersionId, episodeId, JSON.stringify(content), contentHash, job?.created_by || 'transcription-worker']);
      await client.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'transcript',$3,NULL,$4::jsonb,$5,'application/json','forge',$6::jsonb,$7::jsonb,$8)`, [transcriptArtifactId, episodeId, transcriptVersionId, JSON.stringify(content), contentHash, JSON.stringify([versionId]), JSON.stringify({ sourceArtifactId: artifactId, sourceVersionId: versionId, inputSha256: input.sha256, inputSizeBytes: input.sizeBytes, language: transcript.language, model: process.env.FORGE_WHISPER_MODEL || null, provider: process.env.FORGE_WHISPER_COMMAND || null, deterministic: true, schemaVersion: 'forge-transcript-v1' }), job?.created_by || 'transcription-worker']);
    });
    logger.log?.(`Forge transcription completed for episode ${episodeId}`);
    return { stage: 'TRANSCRIPTION', episodeId, inputArtifactId: artifactId, inputVersionId: versionId, artifactId: transcriptArtifactId, versionId: transcriptVersionId, contentHash, language: transcript.language, segmentCount: transcript.segments.length };
  } finally { await fsp.rm(workDir, { recursive: true, force: true }); }
}

function createTranscriptionHandlers({ pool, ...options } = {}) { return { 'workflow:transcription': (payload, job) => executeTranscription({ pool, payload, job, ...options }) }; }

module.exports = { executeTranscription, createTranscriptionHandlers, parseWhisperSegments, downloadImmutableInput, sha256File };
