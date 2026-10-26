const { Pool } = require('pg');
const { JobQueue } = require('../src/persistence/job-queue');

async function main() {
  const [kind, payloadJson = '{}'] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!kind) throw new Error('Usage: node scripts/enqueue-job.js <kind> [json-payload]');
  const payload = JSON.parse(payloadJson);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const queue = new JobQueue({ pool });
    const job = await queue.enqueue({ kind, payload, idempotencyKey: process.env.JOB_IDEMPOTENCY_KEY || undefined, createdBy: process.env.JOB_CREATED_BY || 'cli' });
    console.log(JSON.stringify({ id: job.id, status: job.status, kind: job.kind }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
