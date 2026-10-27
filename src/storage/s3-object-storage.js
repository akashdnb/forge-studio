const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { artifactKey, normalizeSha, hashAndCount } = require('./local-file-storage');
class S3ObjectStorage {
  constructor({ bucket, region = 'us-east-1', endpoint, forcePathStyle = false, maxBytes }) { if (!bucket) throw new TypeError('S3 bucket is required'); this.maxBytes = maxBytes; this.client = new S3Client({ region, endpoint, forcePathStyle }); }
  keyFor(input) { return artifactKey(input); }
  async upload({ stream, tenantId, projectId, kind, contentType = 'application/octet-stream', expectedSha256, metadata = {} }) {
    if (!stream || typeof stream.pipe !== 'function') throw new TypeError('stream is required'); if (expectedSha256) normalizeSha(expectedSha256);
    const tempDir = path.join(os.tmpdir(), 'forge-artifacts', crypto.randomUUID()); await mkdir(tempDir, { recursive: true, mode: 0o700 }); const temp = path.join(tempDir, 'artifact.part');
    try {
      const verifier = hashAndCount(this.maxBytes, expectedSha256); await pipeline(stream, verifier, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const sha256 = verifier.checksum; const sizeBytes = verifier.sizeBytes; const key = artifactKey({ tenantId, projectId, kind, sha256, contentType }); const existing = await this.head(key);
      if (!existing) {
        try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(temp), ContentLength: sizeBytes, ContentType: contentType, Metadata: { sha256, ...safeMetadata(metadata) }, IfNoneMatch: '*' })); }
        catch (error) { if (!(error.$metadata?.httpStatusCode === 412 || error.$metadata?.httpStatusCode === 409)) throw error; }
      }
      const final = await this.head(key); if (!final || final.sizeBytes !== sizeBytes || (final.sha256 && final.sha256 !== sha256)) throw Object.assign(new Error('S3 object failed post-write verification'), { code: 'STORAGE_CORRUPT' });
      return { key, uri: `s3://${this.bucket}/${key}`, sha256, sizeBytes, contentType, metadata };
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }
  async head(key) { try { const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return { key, sizeBytes: Number(result.ContentLength || 0), sha256: result.Metadata?.sha256 || null, contentType: result.ContentType || null, uri: `s3://${this.bucket}/${key}` }; } catch (error) { if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) return null; throw error; } }
  async download({ key, expectedSha256, maxBytes = this.maxBytes }) { const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); const sizeBytes = Number(result.ContentLength || 0); if (sizeBytes > maxBytes) throw Object.assign(new Error('Stored artifact exceeds configured download limit'), { code: 'ARTIFACT_TOO_LARGE' }); const verifier = hashAndCount(maxBytes, expectedSha256 || result.Metadata?.sha256 || undefined); return { stream: result.Body.pipe(verifier), sizeBytes, key, uri: `s3://${this.bucket}/${key}` }; }
  async downloadRange({ key, start, end }) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw Object.assign(new Error('Invalid storage range'), { code: 'INVALID_RANGE' });
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }));
      const contentLength = Number(result.ContentLength || 0);
      return { stream: result.Body, sizeBytes: contentLength, key, uri: `s3://${this.bucket}/${key}` };
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw Object.assign(new Error('Artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
      throw error;
    }
  }
}
function safeMetadata(metadata) { const out = {}; for (const [key, value] of Object.entries(metadata || {})) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new TypeError('Unsafe object metadata key'); const text = String(value); if (Buffer.byteLength(text) > 2048) throw new TypeError('Object metadata value too large'); out[key] = text; } return out; }
module.exports = { S3ObjectStorage, safeMetadata };
