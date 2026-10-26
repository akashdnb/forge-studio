const fs = require('node:fs/promises');
const { Pool } = require('pg');

async function main() {
  const jobId = process.argv[2];
  if (!jobId || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node scripts/verify-render-job.js <render-job-id>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = await pool.query('SELECT result FROM forge_jobs WHERE id=$1 AND kind=\'workflow:render\'', [jobId]);
    const job = result.rows[0];
    if (!job?.result) throw new Error(`Render job ${jobId} has no render result`);
    const uri = job.result.storageUri;
    if (!uri?.startsWith('file://')) throw new Error('Bounded GitHub render must produce a local file artifact');
    const file = new URL(uri);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) throw new Error('Render artifact is missing or empty');
    if (Number(job.result.sizeBytes) !== stat.size) throw new Error('Render artifact size does not match reconciled metadata');
    process.stdout.write(JSON.stringify({ status: 'VERIFIED', jobId, storageUri: uri, sizeBytes: stat.size, checksum: job.result.checksum }) + '\n');
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
