const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { issueToken } = require('../src/security/http-security');
const { installOperationsControlPlane } = require('../src/operations/control-plane');
const { PostgresRepository } = require('../src/persistence/postgres-repository');
const { LocalFileStorage } = require('../src/storage/local-file-storage');
const { Readable } = require('node:stream');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');

const enabled = Boolean(process.env.DATABASE_URL);

test('operations control plane: PostgreSQL, RBAC, tenant isolation, guarded actions, audit and storage', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const repo = new PostgresRepository({ pool });
  await repo.migrate();
  const suffix = randomUUID();
  const tenantA = `ops-tenant-a-${suffix}`;
  const tenantB = `ops-tenant-b-${suffix}`;
  const actorA = `ops-owner-a-${suffix}`;
  const actorB = `ops-owner-b-${suffix}`;
  const projectA = `ops-project-a-${suffix}`;
  const projectB = `ops-project-b-${suffix}`;
  const episodeA = `ops-episode-a-${suffix}`;
  const versionA = `ops-version-a-${suffix}`;
  const artifactA = `ops-artifact-a-${suffix}`;
  const failedJob = `ops-job-failed-${suffix}`;
  const publishJob = `ops-job-publish-${suffix}`;
  const runningJob = `ops-job-running-${suffix}`;
  const secret = `012345678901234567890123456789${suffix.slice(0, 8)}`;
  let tempDir;
  let server;
  try {
    await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3),($4,$5,$6)', [tenantA, 'Ops A', actorA, tenantB, 'Ops B', actorB]);
    await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [projectA, 'Ops Project A', actorA, tenantA, projectB, 'Ops Project B', actorB, tenantB]);
    await pool.query('INSERT INTO project_members(project_id,actor_id,tenant_id,role) VALUES($1,$2,$3,\'OWNER\'),($4,$5,$6,\'OWNER\')', [projectA, actorA, tenantA, projectB, actorB, tenantB]);
    await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeA, projectA, 'Operations episode', actorA]);
    await pool.query('INSERT INTO version_records(id,episode_id,kind,created_by) VALUES($1,$2,\'render\',$3)', [versionA, episodeA, actorA]);

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'forge-ops-'));
    const storage = new LocalFileStorage({ rootDir: tempDir, maxBytes: 1024 * 1024 });
    const payload = Buffer.from('real artifact bytes');
    const stored = await storage.upload({ stream: Readable.from(payload), tenantId: tenantA, projectId: projectA, kind: 'render', contentType: 'application/octet-stream' });
    await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,created_by) VALUES($1,$2,'render',$3,$4,$5,$6,$7)`, [artifactA, episodeA, versionA, stored.uri, stored.sha256, stored.contentType, actorA]);
    await pool.query(`INSERT INTO artifact_lifecycle_records(artifact_id,project_id,state,reference_count) VALUES($1,$2,'RETAINED',1)`, [artifactA, projectA]);
    await pool.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,status,attempts,max_attempts,idempotency_key,created_by,error) VALUES($1,$2,$3,'workflow:render','FAILED',1,3,$1,$4,$5::jsonb),($6,$2,$3,'workflow:publish','FAILED',1,3,$6,$4,'{}'),($7,$2,$3,'workflow:render','RUNNING',1,3,$7,$4,'{}')`, [failedJob, projectA, episodeA, actorA, JSON.stringify({ message: 'render failed' }), publishJob, runningJob]);
    await pool.query(`UPDATE forge_jobs SET worker_id='worker-old',leased_until=now()+interval '5 minutes' WHERE id=$1`, [runningJob]);

    installOperationsControlPlane({ pg: pool, authSecret: secret });
    server = http.createServer();
    server.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const tokenA = issueToken({ subject: actorA, tenantId: tenantA, roles: ['OWNER'], secret });
    const tokenB = issueToken({ subject: actorB, tenantId: tenantB, roles: ['OWNER'], secret });

    async function request(token, method, pathname, body) {
      return new Promise((resolve, reject) => {
        const req = http.request({ port, method, path: pathname, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
          let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject); if (body) req.end(JSON.stringify(body)); else req.end();
      });
    }

    assert.equal((await request(tokenA, 'GET', `/v1/ops/jobs/${failedJob}`)).status, 200);
    assert.equal((await request(tokenB, 'GET', `/v1/ops/jobs/${failedJob}`)).status, 404);
    assert.equal((await request(tokenA, 'GET', '/v1/ops/jobs?limit=101')).status, 400);
    assert.equal((await request(tokenA, 'POST', '/v1/ops/actions/retry', { targetType: 'job', targetId: publishJob, reason: 'Do not duplicate external publication', idempotencyKey: randomUUID() })).body.error.code, 'DANGEROUS_RETRY_REJECTED');

    const idempotencyKey = randomUUID();
    const retryBody = { targetType: 'job', targetId: failedJob, reason: 'Retry failed internal render after provider recovery', idempotencyKey };
    const first = await request(tokenA, 'POST', '/v1/ops/actions/retry', retryBody);
    const replay = await request(tokenA, 'POST', '/v1/ops/actions/retry', retryBody);
    assert.equal(first.status, 200); assert.deepEqual(replay.body.item, first.body.item);
    assert.equal((await pool.query('SELECT status FROM forge_jobs WHERE id=$1', [failedJob])).rows[0].status, 'QUEUED');

    const stale = await request(tokenA, 'POST', '/v1/ops/actions/fence', { targetType: 'job', targetId: runningJob, expectedStatus: 'FAILED', reason: 'Fence stale render worker before recovery', idempotencyKey: randomUUID() });
    assert.equal(stale.status, 409);
    const fenced = await request(tokenA, 'POST', '/v1/ops/actions/fence', { targetType: 'job', targetId: runningJob, expectedStatus: 'RUNNING', reason: 'Fence stale render worker before recovery', idempotencyKey: randomUUID() });
    assert.equal(fenced.status, 200);
    const fencedRow = (await pool.query('SELECT status,worker_id,dispatch_generation FROM forge_jobs WHERE id=$1', [runningJob])).rows[0];
    assert.equal(fencedRow.status, 'QUEUED'); assert.match(fencedRow.worker_id, /^FENCED:/);

    const quarantine = await request(tokenA, 'POST', '/v1/ops/actions/quarantine', { targetType: 'artifact', targetId: artifactA, reason: 'Checksum investigation requires isolation', idempotencyKey: randomUUID() });
    assert.equal(quarantine.status, 200);
    assert.equal((await pool.query('SELECT state FROM artifact_lifecycle_records WHERE artifact_id=$1', [artifactA])).rows[0].state, 'QUARANTINED');
    assert.ok(await storage.head(stored.key));

    const preview = await request(tokenA, 'POST', '/v1/ops/bulk/preview', { action: 'cancel', reason: 'Bounded incident cancellation after operator review', targets: [{ targetType: 'job', targetId: failedJob }], idempotencyKey: randomUUID() });
    assert.equal(preview.status, 200); assert.ok(preview.body.confirmationToken);
    const bulk = await request(tokenA, 'POST', '/v1/ops/bulk/execute', { action: 'cancel', targets: [{ targetType: 'job', targetId: failedJob }], confirmationToken: preview.body.confirmationToken, idempotencyKey: randomUUID() });
    assert.equal(bulk.status, 200); assert.equal(bulk.body.results[0].ok, true);

    const audit = await pool.query(`SELECT action,outcome,target_id FROM security_audit_events WHERE tenant_id=$1 AND target_id IN($2,$3,$4) ORDER BY id`, [tenantA, failedJob, runningJob, artifactA]);
    assert.ok(audit.rows.length >= 4);
    assert.ok(audit.rows.every(row => row.outcome === 'ALLOWED'));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.query('DELETE FROM forge_jobs WHERE id = ANY($1::text[])', [[failedJob, publishJob, runningJob]]).catch(() => {});
    await pool.query('DELETE FROM artifact_lifecycle_records WHERE artifact_id=$1', [artifactA]).catch(() => {});
    await pool.query('DELETE FROM artifacts WHERE id=$1', [artifactA]).catch(() => {});
    await pool.query('DELETE FROM version_records WHERE id=$1', [versionA]).catch(() => {});
    await pool.query('DELETE FROM episodes WHERE id=$1', [episodeA]).catch(() => {});
    await pool.query('DELETE FROM project_members WHERE project_id=ANY($1::text[])', [[projectA, projectB]]).catch(() => {});
    await pool.query('DELETE FROM projects WHERE id=ANY($1::text[])', [[projectA, projectB]]).catch(() => {});
    await pool.query('DELETE FROM tenants WHERE id=ANY($1::text[])', [[tenantA, tenantB]]).catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await pool.end();
  }
});
