const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { LocalFileStorage } = require('../src/storage/local-file-storage');
const { ArtifactStorageService } = require('../src/storage/artifact-storage-service');
const { authenticateManifest } = require('../src/storage/artifact-integrity-manifest');
const { validateFile } = require('../src/media/content-validation');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ffmpegPath = require('ffmpeg-static');

function fixture(root) {
  const file = path.join(root, 'final.mp4');
  const result = spawnSync(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
    '-f', 'mp4', '-movflags', '+faststart', file
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'ffmpeg fixture generation failed');
  return file;
}

function repositoryFor(row) {
  return {
    db: {
      pool: {
        async query(sql) {
          if (sql.includes('FROM artifacts a JOIN episodes')) return { rows: [row] };
          throw new Error(`unexpected SQL in focused artifact retrieval test: ${sql}`);
        }
      }
    }
  };
}

test('final packaged MP4 survives durable storage, openArtifact retrieval, checksum verification and full media decode', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-final-mp4-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await fs.readFile(fixture(root));
  const contentHash = sha256(bytes);
  const tenantId = 'tenant-acceptance';
  const projectId = 'project-acceptance';
  const artifactId = 'artifact-final-mp4';
  const versionId = 'render-version-acceptance';
  const kind = 'render';
  const mediaType = 'video/mp4';
  const storage = new LocalFileStorage({ rootDir: path.join(root, 'objects'), maxBytes: 64 * 1024 * 1024 });
  const stored = await storage.upload({
    stream: Readable.from(bytes),
    tenantId,
    projectId,
    kind,
    contentType: mediaType,
    expectedSha256: contentHash,
    metadata: { acceptance: true, artifactRole: 'final-packaged-mp4' }
  });

  const auth = authenticateManifest({
    tenantId,
    projectId,
    artifactId,
    versionId,
    kind,
    storageKey: stored.key,
    sha256: contentHash,
    sizeBytes: stored.sizeBytes,
    mediaType,
    encryptionMode: 'NONE',
    encryptionKeyId: null
  }, 'forge-acceptance-integrity-key-012345678901234567890123');

  const row = {
    id: artifactId,
    episode_id: 'episode-acceptance',
    project_id: projectId,
    tenant_id: tenantId,
    version_id: versionId,
    kind,
    content_hash: contentHash,
    media_type: mediaType,
    metadata: { acceptance: true },
    storage_key: stored.key,
    status: 'READY',
    stored_hash: contentHash,
    size_bytes: stored.sizeBytes,
    encryption_mode: 'NONE',
    encryption_key_id: null,
    manifest_id: 'manifest-final-mp4',
    manifest_sha256: contentHash,
    manifest_size_bytes: stored.sizeBytes,
    manifest_media_type: mediaType,
    manifest_mac: auth.mac,
    manifest_kind: kind,
    manifest_storage_key: stored.key,
    manifest_encryption_mode: 'NONE',
    manifest_encryption_key_id: null
  };

  const previousKey = process.env.FORGE_ARTIFACT_INTEGRITY_KEY;
  process.env.FORGE_ARTIFACT_INTEGRITY_KEY = 'forge-acceptance-integrity-key-012345678901234567890123';
  t.after(() => {
    if (previousKey === undefined) delete process.env.FORGE_ARTIFACT_INTEGRITY_KEY;
    else process.env.FORGE_ARTIFACT_INTEGRITY_KEY = previousKey;
  });

  const service = new ArtifactStorageService({ storage, repository: repositoryFor(row) });
  const opened = await service.openArtifact({ artifactId, projectId, expectedVersionId: versionId });
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  const retrieved = Buffer.concat(chunks);

  assert.equal(opened.artifactId, artifactId);
  assert.equal(opened.versionId, versionId);
  assert.equal(opened.mediaType, mediaType);
  assert.equal(retrieved.length, bytes.length);
  assert.equal(sha256(retrieved), contentHash);
  assert.equal(sha256(retrieved), row.content_hash);

  const retrievedFile = path.join(root, 'retrieved.mp4');
  await fs.writeFile(retrievedFile, retrieved);
  const validation = await validateFile(retrievedFile, {
    mimeType: mediaType,
    sizeBytes: retrieved.length,
    policy: {
      requireVideo: true,
      requireAudio: true,
      allowedContainers: ['mov', 'mp4'],
      allowedCodecs: ['h264', 'aac'],
      minWidth: 320,
      minHeight: 180,
      maxFps: 60,
      requireCompleteDecode: true
    }
  });

  assert.notEqual(validation.status, 'FAILED', JSON.stringify(validation));
  assert.equal(validation.metadata.format, 'mov');
  assert.equal(validation.metadata.streams.filter((s) => s.type === 'video').length, 1);
  assert.equal(validation.metadata.streams.filter((s) => s.type === 'audio').length, 1);
});
