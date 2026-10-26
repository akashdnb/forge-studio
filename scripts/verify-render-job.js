const fs = require('node:fs/promises');
const { Pool } = require('pg');

async function main() {
  const jobId = process.argv[2];
  if (!jobId || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node scripts/verify-render-job.js <render-job-id>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = await pool.query(
      `SELECT a.id,a.storage_uri,a.content_hash,a.media_type,so.size_bytes
       FROM artifacts a LEFT JOIN storage_objects so ON so.artifact_id=a.id
       WHERE a.id=$1 AND a.kind='render'`,
      [`render:${jobId}`],
    );
    const artifact = result.rows[0];
    if (!artifact) throw new Error(`Render artifact render:${jobId} was not persisted`);
    if (artifact.media_type !== 'video/mp4' || !artifact.content_hash) throw new Error('Render artifact metadata is incomplete');
    if (!artifact.storage_uri?.startsWith('file://')) throw new Error('Bounded GitHub render must produce a local file artifact');
    const file = new URL(artifact.storage_uri);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) throw new Error('Render artifact is missing or empty');
    if (artifact.size_bytes != null && Number(artifact.size_bytes) !== stat.size) throw new Error('Render artifact size does not match storage metadata');
    process.stdout.write(JSON.stringify({ status: 'VERIFIED', jobId, artifactId: artifact.id, storageUri: artifact.storage_uri, sizeBytes: stat.size, checksum: artifact.content_hash }) + '\n');
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
