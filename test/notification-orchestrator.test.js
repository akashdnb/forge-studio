'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextAllowedAt, inQuietHours } = require('../src/notifications/notification-orchestrator');

const poolIntegration = process.env.DATABASE_URL ? test : test.skip;

test('quiet hours handle overnight windows', () => {
  const at = new Date('2026-10-27T22:30:00.000Z');
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const values=Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  assert.equal(inQuietHours(values,{enabled:true,start:22*60,end:7*60}),true);
  const next=nextAllowedAt(at,'Asia/Kolkata',{enabled:true,start:22*60,end:7*60});
  assert.ok(next>at);
});

test('quiet hours honor a DST transition without wall-clock arithmetic', () => {
  const before = new Date('2026-11-01T05:30:00.000Z');
  const next = nextAllowedAt(before,'America/New_York',{enabled:true,start:0,end:180});
  assert.ok(next>before);
  assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(next),'03');
});

poolIntegration('PostgreSQL notification schema is reachable and tenant-isolated', async () => {
  const { Pool } = require('pg');
  const pool = new Pool({connectionString:process.env.DATABASE_URL,max:2});
  try {
    const r=await pool.query(`SELECT to_regclass('forge_notification_intents') AS intents,to_regclass('forge_notification_deliveries') AS deliveries,to_regclass('forge_notification_attempts') AS attempts`);
    assert.equal(r.rows[0].intents,'forge_notification_intents');
    assert.equal(r.rows[0].deliveries,'forge_notification_deliveries');
    assert.equal(r.rows[0].attempts,'forge_notification_attempts');
    const trigger=await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('forge_job_notification_trigger','forge_approval_notification_trigger','forge_incident_notification_trigger','forge_publish_notification_trigger','forge_provider_outage_notification_trigger')`);
    assert.equal(trigger.rows.length,5);
  } finally { await pool.end(); }
});
