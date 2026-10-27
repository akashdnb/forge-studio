'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionTraceStore, safePayload, inferStatus } = require('../src/observability/execution-trace');

class FakePool {
  constructor() { this.trace = new Map(); this.events = []; this.attempts = []; }
  async query(sql, params = []) {
    if (sql.includes('INSERT INTO forge_execution_traces')) {
      const id = params[0];
      if (!this.trace.has(id)) this.trace.set(id, { trace_id: id, correlation_id: params[1], sampled: true, event_count: 0, status: 'RUNNING' });
      return { rows: [this.trace.get(id)] };
    }
    if (sql.includes('SELECT COALESCE(NULLIF(metadata')) return { rows: [{ tenant_id: 'tenant-test' }] };
    if (sql.includes('SELECT * FROM forge_execution_traces')) return { rows: [...this.trace.values()].slice(0, 1) };
    if (sql.includes('SELECT * FROM forge_execution_attempts')) return { rows: this.attempts };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }
  async connect() {
    const pool = this;
    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT trace_id,event_count')) {
          const row = pool.trace.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('INSERT INTO forge_execution_events')) {
          const trace = pool.trace.get(params[0]);
          trace.event_count = Number(params[1]);
          pool.events.push({ trace_id: params[0], sequence: params[1], kind: params[6], payload: params[17] });
          return { rows: [] };
        }
        if (sql.includes('UPDATE forge_execution_traces')) {
          const trace = pool.trace.get(params[0]);
          trace.event_count = Number(params[1]);
          trace.status = params[4] || trace.status;
          return { rows: [] };
        }
        throw new Error(`unexpected transaction query: ${sql.slice(0, 80)}`);
      },
      release() {}
    };
  }
}

test('safePayload strips secrets and content while retaining deterministic diagnostics', () => {
  const value = safePayload({ token: 'do-not-store', prompt: 'secret prompt', stage: 'render', nested: { password: 'x' } }, 4096);
  assert.equal(value.token, '[REDACTED]');
  assert.equal(value.prompt, '[REDACTED]');
  assert.equal(value.nested, '[REDACTED]');
  assert.equal(value.stage, 'render');
});

test('inferStatus reconstructs durable run state from lifecycle events', () => {
  assert.equal(inferStatus('run.blocked'), 'BLOCKED');
  assert.equal(inferStatus('job.retry_scheduled'), 'RETRYING');
  assert.equal(inferStatus('run.failed'), 'FAILED');
  assert.equal(inferStatus('run.published'), 'PUBLISHED');
});

test('concurrent event writers receive deterministic per-trace sequence numbers', async () => {
  const pool = new FakePool();
  const store = new ExecutionTraceStore({ pool, sampleRate: 1, maxEvents: 100 });
  const traceId = '0123456789abcdef0123456789abcdef';
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({ traceId, correlationId: 'corr', kind: `stage.${i}`, payload: { i } })));
  const sequences = pool.events.map(x => Number(x.sequence)).sort((a, b) => a - b);
  assert.deepEqual(sequences, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(sequences).size, 20);
});

test('database failure is fail-open for worker execution diagnostics', async () => {
  const pool = { query: async () => ({ rows: [{ trace_id: 't', correlation_id: 'c', sampled: true, event_count: 0 }] }), connect: async () => ({ query: async () => { throw new Error('injected-db-failure'); }, release() {} }) };
  const store = new ExecutionTraceStore({ pool, sampleRate: 1 });
  const result = await store.append({ traceId: '0123456789abcdef0123456789abcdef', correlationId: 'c', kind: 'job.failed', force: true });
  assert.equal(result, null);
});

const dbUrl = process.env.FORGE_TEST_DATABASE_URL;
test('postgres concurrency: trace sequence allocation remains gap-free', { skip: !dbUrl }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl, max: 8 });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(`CREATE TEMP TABLE forge_execution_traces(trace_id char(32) PRIMARY KEY,correlation_id varchar(128),tenant_id text,project_id text,episode_id text,root_kind varchar(96),status varchar(24) DEFAULT 'RUNNING',started_at timestamptz DEFAULT now(),finished_at timestamptz,last_event_at timestamptz DEFAULT now(),event_count integer DEFAULT 0,sampled boolean DEFAULT true,diagnostic_snapshot jsonb DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());`);
    await pool.query(`CREATE TEMP TABLE forge_execution_events(event_id uuid DEFAULT gen_random_uuid(),trace_id char(32),sequence bigint,observed_at timestamptz,event_time timestamptz,clock_skew_ms integer,kind varchar(64),span_id char(16),parent_span_id char(16),job_id text,attempt integer,worker_id varchar(160),stage varchar(96),outcome varchar(32),reason varchar(128),duration_ms bigint,sampled boolean,payload jsonb,UNIQUE(trace_id,sequence));`);
    const store = new ExecutionTraceStore({ pool, sampleRate: 1, maxEvents: 1000 });
    const traceId = 'abcdefabcdefabcdefabcdefabcdefab';
    await Promise.all(Array.from({ length: 32 }, (_, i) => store.append({ traceId, correlationId: 'postgres-concurrency', kind: `stage.${i}`, payload: { i } })));
    const result = await pool.query('SELECT sequence FROM forge_execution_events WHERE trace_id=$1 ORDER BY sequence', [traceId]);
    assert.deepEqual(result.rows.map(x => Number(x.sequence)), Array.from({ length: 32 }, (_, i) => i + 1));
  } finally { await pool.end(); }
});
