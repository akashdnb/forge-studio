#!/usr/bin/env node
const fs = require('node:fs/promises');
const { Pool } = require('pg');
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try { const result = await pool.query(`SELECT id,backup_path,artifact_archive_path FROM forge_backup_records WHERE status='SUCCEEDED' AND retention_expires_at < now() ORDER BY retention_expires_at LIMIT 50`); let expired = 0; for (const row of result.rows) { await fs.rm(row.backup_path || '', { force: true }).catch(() => {}); await fs.rm(row.artifact_archive_path || '', { force: true }).catch(() => {}); await pool.query("UPDATE forge_backup_records SET status='EXPIRED',integrity_status='EXPIRED' WHERE id=$1", [row.id]); expired += 1; } console.log(JSON.stringify({ expired })); } finally { await pool.end(); }
}
main().catch((error) => { console.error(JSON.stringify({ code: error.code || 'RECOVERY_RETENTION_FAILED', message: error.message })); process.exitCode = 1; });
