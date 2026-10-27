const test = require('node:test');
const assert = require('node:assert/strict');
let Pool; try { ({ Pool } = require('pg')); } catch { Pool = null; }
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const maybe = Pool && databaseUrl ? test : test.skip;
const { nextOccurrence, resolveLocalDateTime, createReleaseScheduleService } = require('../src/scheduling/release-scheduler');
const { JobQueue } = require('../src/persistence/job-queue');

function ids(prefix) { const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`; return { projectId: `${prefix}-project-${suffix}`, episodeId: `${prefix}-episode-${suffix}`, tenantId: `${prefix}-tenant-${suffix}` }; }

test('DST spring-forward resolves a nonexistent wall clock safely', () => {
  const result = resolveLocalDateTime('2027-03-14', '02:30', 'America/New_York');
  assert.equal(result.dstAdjusted, true);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(result.instant), '03:00');
});

test('DST fall-back records ambiguity and selects the earliest instant', () => {
  const result = resolveLocalDateTime('2026-11-01', '01:30', 'America/New_York');
  assert.equal(result.ambiguous, true);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(result.instant), '01:30');
});

test('weekly next-run computation is timezone based, not server-local', () => {
  const after = new Date('2026-10-26T20:00:00.000Z');
  const result = nextOccurrence({ scheduleKind: 'WEEKLY', timezone: 'Asia/Kolkata', localTime: '02:00', weekdays: [2] }, after);
  assert.equal(result.localDate, '2026-10-27');
  assert.equal(result.instant.toISOString(), '2026-10-26T20:30:00.000Z');
});

maybe('PostgreSQL schedule versions are immutable and tenant scoped', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await pool.query('CREATE TEMP TABLE IF NOT EXISTS release_schedule_test_marker(x int)');
  const service = createReleaseScheduleService({ pool, queue: new JobQueue({ pool }), now: () => new Date('2026-10-27T00:00:00.000Z'), workerId: 'release-schedule-test' });
  const { tenantId, projectId, episodeId } = ids('release-schedule');
  await pool.query('INSERT INTO projects(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)', [projectId, tenantId, 'Release test', 'test']);
  await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeId, projectId, 'Release test episode', 'test']);
  const first = await service.create({ tenantId, projectId, episodeId, actor: 'test', scheduleKind: 'DAILY', timezone: 'UTC', localTime: '12:00', destinations: ['youtube'] });
  const second = await service.mutate(first.id, { tenantId, projectId, actor: 'test', action: 'VERSION_CREATED', patch: { timezone: 'America/Los_Angeles', localTime: '09:00' } });
  assert.equal(second.current_version, 2);
  const history = await pool.query('SELECT version,timezone,local_time FROM forge_release_schedule_versions WHERE schedule_id=$1 ORDER BY version', [first.id]);
  assert.equal(history.rows.length, 2);
  assert.equal(history.rows[0].timezone, 'UTC');
  assert.equal(String(history.rows[0].local_time).slice(0, 5), '12:00');
  assert.equal(history.rows[1].timezone, 'America/Los_Angeles');
  await assert.rejects(() => service.get(first.id, `${tenantId}-other`), /release schedule not found/);
  await pool.query('DELETE FROM forge_release_schedules WHERE id=$1', [first.id]);
  await pool.query('DELETE FROM episodes WHERE id=$1', [episodeId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.end();
});

maybe('parallel schedule mutations fence stale versions', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const service = createReleaseScheduleService({ pool, queue: new JobQueue({ pool }), now: () => new Date('2026-10-27T00:00:00.000Z'), workerId: 'release-schedule-race' });
  const { tenantId, projectId, episodeId } = ids('release-race');
  await pool.query('INSERT INTO projects(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)', [projectId, tenantId, 'Race', 'test']);
  await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeId, projectId, 'Race', 'test']);
  const schedule = await service.create({ tenantId, projectId, episodeId, actor: 'test', scheduleKind: 'DAILY', timezone: 'UTC', localTime: '12:00', destinations: ['youtube'] });
  const results = await Promise.allSettled([
    service.mutate(schedule.id, { tenantId, projectId, actor: 'a', action: 'VERSION_CREATED', patch: { localTime: '13:00' } }),
    service.mutate(schedule.id, { tenantId, projectId, actor: 'b', action: 'VERSION_CREATED', patch: { localTime: '14:00' } }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'CONFLICT').length, 1);
  await pool.query('DELETE FROM forge_release_schedules WHERE id=$1', [schedule.id]);
  await pool.query('DELETE FROM episodes WHERE id=$1', [episodeId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.end();
});
