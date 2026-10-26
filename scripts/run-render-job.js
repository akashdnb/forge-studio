const { Pool } = require('pg');
const { JobQueue } = require('../src/persistence/job-queue');
const { createFfmpegRenderHandler } = require('../src/pipeline/ffmpeg-render-handler');

async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('usage: node scripts/run-render-job.js <render-job-id>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const queue = new JobQueue({ pool, leaseSeconds: Number.parseInt(process.env.FORGE_RENDER_LEASE_SECONDS || '1800', 10) });
  const workerId = `forge-render-gha:${process.env.GITHUB_RUN_ID || 'local'}`;
  try {
    const claimed = await queue.claimSpecific(jobId, workerId);
    if (!claimed) {
      const existing = await queue.get(jobId);
      if (existing?.status === 'SUCCEEDED') return;
      throw new Error(`Render job ${jobId} is not claimable (status=${existing?.status || 'missing'})`);
    }
    if (claimed.kind !== 'workflow:render') throw new Error(`Job ${jobId} is ${claimed.kind}, not workflow:render`);
    const handler = createFfmpegRenderHandler({ pool });
    const result = await handler(claimed.payload, claimed);
    process.stdout.write(JSON.stringify({ status: 'RENDERED', jobId, workerId, result }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
