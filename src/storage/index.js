const { LocalFileStorage } = require('./local-file-storage');
const { S3ObjectStorage } = require('./s3-object-storage');
function createStorageFromEnv(overrides = {}) {
  const driver = overrides.driver || process.env.FORGE_STORAGE_DRIVER || 'local';
  const maxBytes = Number(overrides.maxBytes || process.env.FORGE_STORAGE_MAX_BYTES || 10737418240);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('FORGE_STORAGE_MAX_BYTES must be a positive safe integer');
  if (driver === 'local') return new LocalFileStorage({ rootDir: overrides.rootDir || process.env.FORGE_STORAGE_LOCAL_ROOT || '.forge-storage', maxBytes });
  if (driver === 's3') return new S3ObjectStorage({ bucket: overrides.bucket || process.env.FORGE_STORAGE_S3_BUCKET, region: overrides.region || process.env.FORGE_STORAGE_S3_REGION || 'us-east-1', endpoint: overrides.endpoint || process.env.FORGE_STORAGE_S3_ENDPOINT || undefined, forcePathStyle: overrides.forcePathStyle ?? process.env.FORGE_STORAGE_S3_FORCE_PATH_STYLE === 'true', maxBytes });
  throw new TypeError(`Unsupported FORGE_STORAGE_DRIVER: ${driver}`);
}
module.exports = { createStorageFromEnv, LocalFileStorage, S3ObjectStorage };
