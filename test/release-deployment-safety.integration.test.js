'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('release deployment safety schema is fail-closed under mixed versions and migration races', { skip: !hasDatabase }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const releaseId = `test-release-${randomUUID()}`;
  const jobId = randomUUID();
  const workerId = `test-worker-${randomUUID()}`;
  const previous = (await pool.query('SELECT * FROM forge_release_state WHERE id=true')).rows[0];
  try {
    await pool.query(`INSERT INTO forge_release_manifests(id,release_id,commit_sha,manifest_hash,app_version,schema_version,min_schema_version,max_schema_version,compatibility_window,rollback_policy,created_by,migration_manifest,required_protocol_version,rollout_policy,health_policy) VALUES($1,$1,$2,$3,'1.2.3','25','25','25','{"allowPreviousEpoch":false}'::jsonb,'{}'::jsonb,'test','[{"name":"025_test","unsafe":true}]'::jsonb,'2','{}'::jsonb,'{"maxStaleRunnerExecutions":0}'::jsonb)`, [releaseId, 'a'.repeat(40), 'b'.repeat(64)]);
    await pool.query("UPDATE forge_release_state SET active_release_id=$1,state='DEPLOYED',epoch=9,updated_at=now() WHERE id=true", [releaseId]);
    await pool.query(`INSERT INTO forge_worker_fences(worker_id,release_id,app_version,schema_version,status,last_seen_at) VALUES($1,$2,'1.2.3','25','ACTIVE',now())`, [workerId, releaseId]);

    await pool.query(`INSERT INTO forge_jobs(id,kind,status,priority,max_attempts,idempotency_key,created_by,required_release_id,required_release_epoch,required_schema_version,required_protocol_version) VALUES($1,'workflow:test','QUEUED',10,1,$1,'test',$2,8,'25','1')`, [jobId, releaseId]);
    await assert.rejects(
      pool.query("UPDATE forge_jobs SET status='RUNNING',worker_id=$1 WHERE id=$2", [workerId, jobId]),
      /protocol version 1 is incompatible|stale release epoch/i,
    );

    await pool.query("UPDATE forge_jobs SET status='QUEUED',required_release_epoch=9,required_protocol_version='2' WHERE id=$1", [jobId]);
    await pool.query("UPDATE forge_jobs SET status='RUNNING',worker_id=$1 WHERE id=$2", [workerId, jobId]);
    await pool.query("UPDATE forge_jobs SET status='FAILED',worker_id=NULL WHERE id=$1", [jobId]);

    const activeJob = randomUUID();
    await pool.query(`INSERT INTO forge_jobs(id,kind,status,priority,max_attempts,idempotency_key,created_by,required_release_id,required_release_epoch,required_schema_version,required_protocol_version) VALUES($1,'workflow:active','RUNNING',10,1,$1,'test',$2,9,'25','2')`, [activeJob, releaseId]);
    await assert.rejects(
      pool.query("UPDATE forge_release_manifests SET status='DEPLOYING' WHERE release_id=$1", [releaseId]),
      /Unsafe release migration cannot start/i,
    );
    await pool.query("DELETE FROM forge_jobs WHERE id=$1", [activeJob]);
  } finally {
    await pool.query('DELETE FROM forge_worker_fences WHERE worker_id=$1', [workerId]);
    await pool.query('DELETE FROM forge_jobs WHERE id=$1', [jobId]);
    await pool.query('DELETE FROM forge_release_recovery_checkpoints WHERE release_id=$1', [releaseId]);
    await pool.query('DELETE FROM forge_release_deployment_checks WHERE release_id=$1', [releaseId]);
    await pool.query('DELETE FROM forge_release_audit WHERE release_id=$1', [releaseId]);
    await pool.query('DELETE FROM forge_release_approvals WHERE release_id=$1', [releaseId]);
    await pool.query('DELETE FROM forge_release_manifests WHERE release_id=$1', [releaseId]);
    await pool.query('UPDATE forge_release_state SET active_release_id=$1,previous_release_id=$2,state=$3,epoch=$4,updated_at=now() WHERE id=true', [previous.active_release_id, previous.previous_release_id, previous.state, previous.epoch]);
    await pool.end();
  }
});
