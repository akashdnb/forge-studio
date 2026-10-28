#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { ArtifactStorageService } = require('../src/storage/artifact-storage-service');
const { createStorageFromEnv } = require('../src/storage');
const { validateFile } = require('../src/media/content-validation');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const id = (prefix, seed) => `${prefix}:${crypto.createHash('sha256').update(`${prefix}:${seed}`).digest('hex').slice(0, 24)}`;

async function verifyFinalArtifact({ pool, storage, episodeId, projectId, tempRoot }) {
  const pkg = (await pool.query(`SELECT id, final_media_artifact_id, final_media_version_id FROM episode_packages WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1`, [episodeId])).rows[0];
  if (!pkg) throw new Error('final artifact gate: episode package is missing');
  if (!pkg.final_media_artifact_id) throw new Error('final artifact gate: final_media_artifact_id is missing');
  if (!pkg.final_media_version_id) throw new Error('final artifact gate: final_media_version_id is missing');
  const artifact = (await pool.query(`SELECT a.id, a.episode_id, a.project_id, a.version_id, a.content_hash, a.media_type, s.storage_key, s.status AS storage_status, s.content_hash AS stored_hash, s.size_bytes AS storage_size_bytes, s.checksum_verified FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE a.id=$1 AND a.episode_id=$2 AND a.project_id=$3`, [pkg.final_media_artifact_id, episodeId, projectId])).rows[0];
  if (!artifact) throw new Error('final artifact gate: persisted final artifact is missing or not episode-scoped');
  if (artifact.version_id !== pkg.final_media_version_id) throw new Error('final artifact gate: final artifact version mismatch');
  if (!artifact.storage_key) throw new Error('final artifact gate: persisted storage object is missing');
  if (artifact.storage_status !== 'READY') throw new Error(`final artifact gate: storage object is ${artifact.storage_status || 'missing'}`);
  if (artifact.checksum_verified !== true) throw new Error('final artifact gate: storage checksum was not verified');
  if (!artifact.content_hash || !/^[a-f0-9]{64}$/.test(artifact.content_hash)) throw new Error('final artifact gate: artifact checksum is missing or malformed');
  if (artifact.stored_hash !== artifact.content_hash) throw new Error('final artifact gate: persisted storage checksum does not match artifact checksum');
  if (artifact.media_type !== 'video/mp4') throw new Error(`final artifact gate: expected video/mp4, got ${artifact.media_type || 'missing'}`);
  const service = new ArtifactStorageService({ storage, repository: { db: { pool } } });
  const opened = await service.openArtifact({ artifactId: artifact.id, projectId, expectedVersionId: pkg.final_media_version_id });
  const chunks = []; for await (const chunk of opened.stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new Error('final artifact gate: retrieved final artifact is empty');
  if (sha256(bytes) !== artifact.content_hash) throw new Error('final artifact gate: retrieved bytes failed SHA-256 verification');
  if (artifact.storage_size_bytes != null && Number(artifact.storage_size_bytes) !== bytes.length) throw new Error('final artifact gate: retrieved size does not match persisted storage metadata');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, 'final-artifact.mp4'); await fs.writeFile(file, bytes);
  const validation = await validateFile(file, { mimeType: artifact.media_type, sizeBytes: bytes.length, policy: { requireVideo: true, requireAudio: true, allowedContainers: ['mov', 'mp4'], allowedCodecs: ['h264', 'aac'], minWidth: 320, minHeight: 180, maxFps: 60, requireCompleteDecode: true } });
  if (validation.status === 'FAILED') throw new Error(`final artifact gate: MP4 validation failed: ${JSON.stringify(validation)}`);
  return { episodeId, packageId: pkg.id, artifactId: artifact.id, versionId: artifact.version_id, sizeBytes: bytes.length, sha256: artifact.content_hash, mediaType: artifact.media_type, validation: validation.metadata };
}

async function main() {
  const seed = process.env.FORGE_ACCEPTANCE_SEED; const databaseUrl = process.env.DATABASE_URL;
  if (!seed) throw new Error('final artifact gate requires FORGE_ACCEPTANCE_SEED');
  if (!databaseUrl) throw new Error('final artifact gate requires DATABASE_URL');
  const episodeId = id('episode', seed); const projectId = id('project', seed);
  const root = path.resolve(process.env.FORGE_ACCEPTANCE_STORAGE || path.join(process.cwd(), `.forge-acceptance-${seed}`));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-final-artifact-gate-')); const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try { const storage = createStorageFromEnv(); const result = await verifyFinalArtifact({ pool, storage, episodeId, projectId, tempRoot }); console.log(JSON.stringify({ status: 'PASSED', ...result }, null, 2)); }
  finally { await pool.end(); await fs.rm(tempRoot, { recursive: true, force: true }); }
}
if (require.main === module) main().catch((error) => { console.error(JSON.stringify({ status: 'FAILED', error: error.message }, null, 2)); process.exitCode = 1; });
module.exports = { verifyFinalArtifact };
