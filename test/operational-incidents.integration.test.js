'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IncidentManager, fingerprint, safeEvidence } = require('../src/incidents/incident-manager');
const { installIncidentConcurrencyBridge } = require('../src/incidents/concurrency-bridge');
const { installIncidentEventSubscriptionBridge } = require('../src/incidents/event-subscription-bridge');
const { DurableEventDelivery } = require('../src/events/durable-delivery');
const { Pool } = require('pg');
const { runSafeMigrations } = require('../src/release-safety/migration-runner');

installIncidentConcurrencyBridge();
installIncidentEventSubscriptionBridge();

test('incident fingerprints and evidence are deterministic and secret-safe', () => {
  assert.equal(fingerprint('stuck_job','p1','job','j1'), fingerprint('stuck_job','p1','job','j1'));
  assert.notEqual(fingerprint('stuck_job','p1','job','j1'), fingerprint('stuck_job','p1','job','j2'));
  assert.deepEqual(safeEvidence({ jobId:'j1', status:'RUNNING', authorization:'Bearer secret', password:'x', payload:'do-not-store' }), { jobId:'j1', status:'RUNNING' });
});

test('PostgreSQL incident lifecycle, dedupe, tenant isolation, escalation and durable notification', { skip: !process.env.DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const tenantA = `it-tenant-a-${crypto.randomUUID()}`;
  const tenantB = `it-tenant-b-${crypto.randomUUID()}`;
  const projectA = `it-project-a-${crypto.randomUUID()}`;
  const projectB = `it-project-b-${crypto.randomUUID()}`;
  const episodeA = `it-episode-a-${crypto.randomUUID()}`;
  const episodeB = `it-episode-b-${crypto.randomUUID()}`;
  const jobA = `it-job-a-${crypto.randomUUID()}`;
  try {
    await runSafeMigrations({ pool, actor: 'incident-integration-test' });
    await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3),($4,$5,$6)', [tenantA,'Incident A','test',tenantB,'Incident B','test']);
    await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [projectA,'Project A','test',tenantA,projectB,'Project B','test',tenantB]);
    await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [episodeA,projectA,'Episode A','test',episodeB,projectB,'Episode B','test']);
    await pool.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,status,attempts,max_attempts,idempotency_key,created_by,started_at,updated_at) VALUES($1,$2,$3,'workflow:test','RUNNING',1,3,$4,'test',now()-interval '1 hour',now()-interval '1 hour')`, [jobA,projectA,episodeA,`idem-${jobA}`]);

    const manager = new IncidentManager({ pool, now: () => Date.now() });
    await manager.ensureRules(tenantA);
    await manager.ensureRules(tenantB);
    const rule = (await pool.query(`SELECT * FROM incident_rules WHERE tenant_id=$1 AND rule_key='stuck_job'`, [tenantA])).rows[0];
    const observation = { projectId: projectA, episodeId: episodeA, sourceType:'job', sourceId:jobA, title:'Job stuck', summary:'workflow:test has not progressed', evidence:{jobId:jobA,status:'RUNNING',authorization:'secret'} };

    const [first, second] = await Promise.all([
      manager.recordObservation({ tenantId:tenantA, rule, observation }),
      manager.recordObservation({ tenantId:tenantA, rule, observation }),
    ]);
    assert.equal(first.incident.id, second.incident.id);
    const count = (await pool.query('SELECT count(*)::int count FROM operational_incidents WHERE tenant_id=$1 AND fingerprint=$2', [tenantA, fingerprint('stuck_job',projectA,'job',jobA)])).rows[0].count;
    assert.equal(count, 1);

    await manager.recordObservation({ tenantId:tenantB, rule:{...rule, tenant_id:tenantB, id:`rule-${tenantB}`}, observation:{...observation, projectId:projectB, episodeId:episodeB, sourceId:`job-${crypto.randomUUID()}`} });
    assert.equal((await manager.list({tenantId:tenantA})).every(row => row.tenant_id === tenantA), true);
    assert.equal((await manager.list({tenantId:tenantA})).some(row => row.project_id === projectB), false);

    const incident = await manager.get(tenantA, first.incident.id);
    assert.equal(incident.evidence.authorization, undefined);
    await manager.transition({tenantId:tenantA,incidentId:first.incident.id,actorId:'operator-a',action:'ACKNOWLEDGE',reason:'Operator is actively investigating',idempotencyKey:'ack-1'});
    const ackReplay = await manager.transition({tenantId:tenantA,incidentId:first.incident.id,actorId:'operator-a',action:'ACKNOWLEDGE',reason:'Operator is actively investigating',idempotencyKey:'ack-1'});
    assert.equal(ackReplay.status,'ACKNOWLEDGED');
    await manager.transition({tenantId:tenantA,incidentId:first.incident.id,actorId:'operator-a',action:'RESOLVE',reason:'Root cause fixed and worker recovered',resolutionEvidence:{jobId:jobA,status:'RECOVERED',token:'must-not-leak'},idempotencyKey:'resolve-1'});
    assert.equal((await manager.get(tenantA, first.incident.id)).status,'RESOLVED');

    process.env.FORGE_EVENT_SECRET_KEY = process.env.FORGE_EVENT_SECRET_KEY || 'incident-test-event-secret-123';
    const delivery = new DurableEventDelivery({pool});
    const sub = await delivery.createSubscription({tenantId:tenantA,projectId:projectA,endpointUrl:'https://example.com/forge-incidents',eventTypes:['incident.created'],secret:'subscription-secret-12345',createdBy:'operator-a'});
    assert.deepEqual(sub.event_types,['incident.created']);
    const createdEvent = (await pool.query(`SELECT id,type,payload FROM forge_events WHERE tenant_id=$1 AND project_id=$2 AND type='incident.created' ORDER BY created_at DESC LIMIT 1`, [tenantA,projectA])).rows[0];
    assert.ok(createdEvent);
    await delivery.fanout(100);
    const pending = (await pool.query(`SELECT status FROM forge_event_deliveries WHERE subscription_id=$1 AND event_id=$2`, [sub.id,createdEvent.id])).rows[0];
    assert.equal(pending.status,'PENDING');
    assert.equal(JSON.stringify(createdEvent.payload).includes('subscription-secret'),false);
  } finally {
    await pool.end();
  }
});
