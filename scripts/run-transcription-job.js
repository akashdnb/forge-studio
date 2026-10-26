const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const { executeTranscription } = require('../src/transcription/whisper-worker');

async function uploadOutput(content, uri) {
  if (!uri) return null;
  let parsed; try { parsed = new URL(uri); } catch { throw new Error('FORGE_TRANSCRIPTION_OUTPUT_URL must be an absolute HTTPS URL'); }
  if (parsed.protocol !== 'https:') throw new Error('FORGE_TRANSCRIPTION_OUTPUT_URL must use HTTPS');
  const body = Buffer.from(JSON.stringify(content));
  const checksum = crypto.createHash('sha256').update(body).digest('hex');
  const response = await fetch(uri, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-content-sha256': checksum }, body });
  if (!response.ok) throw Object.assign(new Error(`Transcript output upload failed with HTTP ${response.status}`), { retryable: response.status >= 500 });
  return { uri, sha256: checksum, bytes: body.length };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const jobId = process.argv[2] || process.env.FORGE_TRANSCRIPTION_JOB_ID;
  if (!jobId) throw new Error('Usage: node scripts/run-transcription-job.js <job-id>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const jobResult = await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [jobId]);
    const job = jobResult.rows[0];
    if (!job || job.kind !== 'workflow:transcription') throw new Error('Job is not a transcription job');
    if (job.status === 'SUCCEEDED') { console.log(JSON.stringify(job.result)); return; }
    if (job.status !== 'RUNNING') throw new Error(`Job must be RUNNING before execution; found ${job.status}`);
    const result = await executeTranscription({ pool, payload: job.payload, job });
    if (process.env.FORGE_TRANSCRIPTION_OUTPUT_URL) {
      const artifact = await pool.query('SELECT content_json FROM artifacts WHERE id=$1', [result.artifactId]);
      if (!artifact.rows[0]) throw new Error('Transcript artifact disappeared before output upload');
      result.outputUpload = await uploadOutput(artifact.rows[0].content_json, process.env.FORGE_TRANSCRIPTION_OUTPUT_URL);
    }
    await pool.query(`UPDATE forge_jobs SET status='SUCCEEDED', result=$1::jsonb, leased_until=NULL, finished_at=now(), updated_at=now() WHERE id=$2 AND status='RUNNING'`, [JSON.stringify(result), jobId]);
    console.log(JSON.stringify(result));
  } catch (error) {
    const retryable = error.retryable === true;
    await pool.query(`UPDATE forge_jobs SET status=CASE WHEN $1 AND attempts < max_attempts THEN 'QUEUED' ELSE 'FAILED' END, available_at=CASE WHEN $1 AND attempts < max_attempts THEN now()+interval '30 seconds' ELSE available_at END, leased_until=NULL, worker_id=NULL, error=$2::jsonb, finished_at=CASE WHEN NOT ($1 AND attempts < max_attempts) THEN now() ELSE NULL END, updated_at=now() WHERE id=$3 AND status='RUNNING'`, [retryable, JSON.stringify({ code: error.code || 'TRANSCRIPTION_FAILED', message: error.message }), jobId]);
    console.error(JSON.stringify({ error: error.message, code: error.code || 'TRANSCRIPTION_FAILED', retryable }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}

main();
