'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCron, nextCronOccurrence, resolveLocalDateTime } = require('../src/scheduling/durable-scheduler');

function utc(value) { return new Date(value); }

test('cron parser supports lists, ranges, steps and names', () => {
  const cron = parseCron('*/15 9-17 * JAN,MAR MON-FRI');
  assert.equal(cron.minute.has(30), true);
  assert.equal(cron.hour.has(12), true);
  assert.equal(cron.month.has(1), true);
  assert.equal(cron.dow.has(1), true);
});

test('DST spring gap is skipped deterministically', () => {
  const after = utc('2026-03-07T00:00:00.000Z');
  const next = nextCronOccurrence('30 2 * * *', after, 'America/New_York', 'SKIP', 'EARLIER');
  assert.equal(next.instant.toISOString(), '2026-03-09T06:30:00.000Z');
});

test('DST spring gap can be shifted forward', () => {
  const after = utc('2026-03-07T00:00:00.000Z');
  const next = nextCronOccurrence('30 2 * * *', after, 'America/New_York', 'SHIFT_FORWARD', 'EARLIER');
  assert.equal(next.instant.toISOString(), '2026-03-08T07:00:00.000Z');
});

test('DST fall fold exposes both instants when requested', () => {
  const matches = resolveLocalDateTime({ date: '2026-11-01', hour: 1, minute: 30 }, 'America/New_York', 'SKIP', 'BOTH');
  assert.deepEqual(matches.map(x => x.toISOString()), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
});

test('DST fall fold is deterministic for earlier and later policies', () => {
  const earlier = resolveLocalDateTime({ date: '2026-11-01', hour: 1, minute: 30 }, 'America/New_York', 'SKIP', 'EARLIER');
  const later = resolveLocalDateTime({ date: '2026-11-01', hour: 1, minute: 30 }, 'America/New_York', 'SKIP', 'LATER');
  assert.equal(earlier[0].toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(later[0].toISOString(), '2026-11-01T06:30:00.000Z');
});

test('day-of-month and day-of-week follow cron OR semantics when both are restricted', () => {
  const after = utc('2026-04-01T00:00:00.000Z');
  const next = nextCronOccurrence('0 0 1 * MON', after, 'UTC');
  assert.equal(next.instant.toISOString(), '2026-04-06T00:00:00.000Z');
});

test('invalid IANA zones and cron fields are rejected', () => {
  assert.throws(() => nextCronOccurrence('0 0 * * *', new Date(), 'Not/AZone'), /invalid IANA timezone/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
});

test('PostgreSQL integration tests are opt-in', { skip: !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const { DurableScheduler } = require('../src/scheduling/durable-scheduler');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('SELECT 1');
    await pool.query('SELECT to_regclass(\'forge_schedules\')');
    const scheduler = new DurableScheduler({ pool, schedulerId: `test:${process.pid}` });
    const health = await scheduler.health();
    assert.equal(typeof health.active, 'number');
  } finally { await pool.end(); }
});
