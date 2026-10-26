const { Pool } = require('pg');
const { JobQueue } = require('../src/persistence/job-queue');

async function main() {
  const jobId = process.argv[2];
  const status = process.argv[3];
  if (!jobId || !['SUCCEEDED', 'FAILED'].includes(status) || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node scripts/reconcile-render-job.js <render-job-id> <SUCCEEDED|FAILED>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const queue = new JobQueue({ pool, leaseSeconds: Number.parseInt(process.env.FORGE_RENDER_LEASE_SECONDS || '1800', 10) });
  const workerId = `forge-render-gha:${process.env.GITHUB_RUN_ID || 'local'}`;
  try {
    const current = await queue.get(jobId);
    if (!current) throw new Error(`Render job ${jobId} does not exist`);
    if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return process.stdout.write(JSON.stringify({ status: current.status, jobId, reconciled: true, alreadyTerminal: true }) + '\n');
    if (status === 'SUCCEEDED') {
      const result = await pool.query('SELECT id,version_id,storage_uri,content_hash,media_type,metadata FROM artifacts WHERE id=$1 AND kind=\'render\'', [`render:${jobId}`]);
      if (!result.rows[0]) throw new Error(`Render artifact render:${jobId} is missing`);
      await queue.succeed(jobId, workerId, {
        stage: 'RENDER', artifactId: result.rows[0].id, versionId: result.rows[0].version_id,
        storageUri: result.rows[0].storage_uri, checksum: result.rows[0].content_hash, mediaType: result.rows[0].media_type,
        metadata: result.rows[0].metadata, reconciledBy: process.env.GITHUB_RUN_ID || 'local',
      });
    } else if (current.status === 'RUNNING' && current.worker_id === workerId) {
      await queue.fail(jobId, workerId, Object.assign(new Error(`Bounded render workflow failed (run ${process.env.GITHUB_RUN_ID || 'local'})`), { retryable: true }), { retry: true, delaySeconds: 30 });
    } else {
      return process.stdout.write(JSON.stringify({ status: current.status, jobId, reconciled: false, note: 'Job is not owned by this bounded executor' }) + '\n');
    }
    process.stdout.write(JSON.stringify({ status, jobId, reconciled: true }) + '\n');
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
