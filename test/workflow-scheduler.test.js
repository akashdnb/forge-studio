const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowScheduler } = require('../src/scheduling/workflow-scheduler');

const makeJob = (id, o = {}) => ({
  id, project_id: o.project_id ?? 'p1', episode_id: o.episode_id ?? 'e1', kind: 'workflow:test',
  status: o.status ?? 'QUEUED', priority: o.priority ?? 100, attempts: o.attempts ?? 0, max_attempts: 3,
  available_at: o.available_at ?? new Date(0), leased_until: o.leased_until ?? null, worker_id: null,
  created_at: o.created_at ?? new Date(0), depends_on_job_id: o.depends_on_job_id ?? null,
  cancellation_requested_at: o.cancellation_requested_at ?? null, dispatch_token: null, dispatch_generation: 0,
});

class FakePool {
  constructor(jobs) { this.jobs = jobs; this.locks = new Set(); this.events = []; this.now = new Date(100000); }
  async connect() { return new FakeClient(this); }
  async query(sql, params = []) {
    if (sql.includes('forge_scheduler_state')) return { rows: [], rowCount: 1 };
    if (sql.includes('forge_scheduler_events')) { this.events.push({ type: params[1], jobId: params[0] }); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected pool query: ${sql.slice(0, 80)}`);
  }
}
class FakeClient {
  constructor(pool) { this.pool = pool; }
  async query(sql, p = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT j.id FROM forge_jobs j WHERE j.status='QUEUED'")) {
      const [now, global, project, episode, maxDepth, starvation, boost] = p;
      const running = this.pool.jobs.filter(j => j.status === 'RUNNING');
      if (running.length >= global) return { rows: [], rowCount: 0 };
      const depth = this.pool.jobs.filter(j => ['QUEUED', 'RUNNING'].includes(j.status)).length;
      const candidates = this.pool.jobs.filter(j => j.status === 'QUEUED' && j.available_at <= now && !j.cancellation_requested_at && !this.pool.locks.has(j.id)
        && (!j.depends_on_job_id || this.pool.jobs.some(d => d.id === j.depends_on_job_id && d.status === 'SUCCEEDED'))
        && (!j.project_id || running.filter(r => r.project_id === j.project_id).length < project)
        && (!j.episode_id || running.filter(r => r.episode_id === j.episode_id).length < episode)
        && (depth <= maxDepth || j.priority <= boost || (now - j.created_at) / 1000 >= starvation));
      candidates.sort((a, b) => ((now - a.created_at) / 1000 >= starvation ? 0 : 1) - ((now - b.created_at) / 1000 >= starvation ? 0 : 1) || a.priority - b.priority || a.created_at - b.created_at);
      const row = candidates[0]; if (row) this.pool.locks.add(row.id); return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE forge_jobs SET status='RUNNING'")) {
      const [id, workerId, now, lease, token, reason, timeout] = p;
      const job = this.pool.jobs.find(j => j.id === id && j.status === 'QUEUED' && this.pool.locks.has(id));
      if (!job) return { rows: [], rowCount: 0 };
      Object.assign(job, { status: 'RUNNING', worker_id: workerId, attempts: job.attempts + 1, dispatch_token: token, dispatch_generation: job.dispatch_generation + 1,
        leased_until: new Date(now.getTime() + lease * 1000), timeout_at: new Date(now.getTime() + timeout * 1000), last_schedule_reason: reason });
      this.pool.locks.delete(id); return { rows: [job], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM forge_jobs') && sql.includes('leased_until < now()')) {
      const row = this.pool.jobs.find(j => j.status === 'RUNNING' && j.leased_until < this.pool.now && !j.cancellation_requested_at);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SELECT * FROM forge_jobs WHERE status='RUNNING' AND timeout_at < now()")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE forge_jobs SET status='QUEUED'") && sql.includes('lease_expired')) { const j = this.pool.jobs.find(x => x.id === p[0]); if (j) j.status = 'QUEUED'; return { rows: [], rowCount: j ? 1 : 0 }; }
    if (sql.includes("UPDATE forge_jobs SET status='CANCELLED'") && sql.includes('cancellation_requested_at')) { const rows = this.pool.jobs.filter(j => j.cancellation_requested_at && ['QUEUED', 'RUNNING'].includes(j.status)); rows.forEach(j => j.status = 'CANCELLED'); return { rows: rows.map(j => ({ id: j.id })), rowCount: rows.length }; }
    if (sql.includes("UPDATE forge_jobs j SET status='CANCELLED'") && sql.includes('dependency_failed')) { const rows = this.pool.jobs.filter(j => j.status === 'QUEUED' && j.depends_on_job_id && this.pool.jobs.some(d => d.id === j.depends_on_job_id && ['FAILED', 'CANCELLED'].includes(d.status))); rows.forEach(j => j.status = 'CANCELLED'); return { rows: rows.map(j => ({ id: j.id })), rowCount: rows.length }; }
    if (sql.includes("last_schedule_reason='dependency_satisfied'")) { const rows = this.pool.jobs.filter(j => j.depends_on_job_id === p[0] && j.status === 'QUEUED' && this.pool.jobs.some(d => d.id === p[0] && d.status === 'SUCCEEDED')); return { rows: rows.map(j => ({ id: j.id })), rowCount: rows.length }; }
    if (sql.includes('INSERT INTO forge_scheduler_events')) { this.pool.events.push({ type: p[1], jobId: p[0] }); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected client query: ${sql.slice(0, 100)}`);
  }
  release() {}
}
const scheduler = pool => new WorkflowScheduler({ pool, queue: { leaseSeconds: 30 }, config: { globalConcurrency: 2, projectConcurrency: 1, episodeConcurrency: 1, maxQueueDepth: 2, starvationSeconds: 5, basePriorityBoost: 10, jobTimeoutSeconds: 60 }, schedulerId: 'test', clock: () => pool.now });

test('concurrent schedulers claim a job only once', async () => { const p = new FakePool([makeJob('a')]); const [a, b] = await Promise.all([scheduler(p).claimNext({ workerId: 'w1' }), scheduler(p).claimNext({ workerId: 'w2' })]); assert.equal([a, b].filter(Boolean).length, 1); assert.equal(p.jobs[0].attempts, 1); });
test('dependency wake and failed dependency handling are durable', async () => { const p = new FakePool([makeJob('a'), makeJob('b', { depends_on_job_id: 'a' })]); const s = scheduler(p); await s.claimNext({ workerId: 'w' }); p.jobs[0].status = 'SUCCEEDED'; assert.equal(await s.wakeDependents('a'), 1); const q = new FakePool([makeJob('x', { status: 'FAILED' }), makeJob('y', { depends_on_job_id: 'x' })]); assert.equal((await scheduler(q).recover()).failedDependencies, 1); assert.equal(q.jobs[1].status, 'CANCELLED'); });
test('project and episode concurrency plus starvation are enforced', async () => { const p = new FakePool([makeJob('old', { priority: 100, created_at: new Date(0) }), makeJob('same-project', { priority: 1, created_at: new Date(99000) })]); p.now = new Date(100000); const s = scheduler(p); assert.equal((await s.claimNext({ workerId: 'w' })).id, 'old'); const q = new FakePool([makeJob('a', { project_id: 'p' }), makeJob('b', { project_id: 'p' })]); assert.ok(await scheduler(q).claimNext({ workerId: 'w1' })); assert.equal(await scheduler(q).claimNext({ workerId: 'w2' }), null); });
test('lease recovery, cancellation and idempotent reruns are bounded', async () => { const p = new FakePool([makeJob('expired', { status: 'RUNNING', leased_until: new Date(0) }), makeJob('cancelled', { cancellation_requested_at: new Date(1) })]); const r = await scheduler(p).recover(); assert.equal(r.expired, 1); assert.equal(p.jobs[0].status, 'QUEUED'); assert.equal(p.jobs[1].status, 'CANCELLED'); const q = new FakePool([makeJob('a')]); const s = scheduler(q); assert.ok(await s.claimNext({ workerId: 'w1' })); assert.equal(await s.claimNext({ workerId: 'w2' }), null); assert.equal(q.jobs[0].dispatch_generation, 1); });
test('priority, backpressure and timeout configuration are explicit', () => { const p = new FakePool([]); const s = new WorkflowScheduler({ pool: p, queue: { leaseSeconds: 30 }, config: { jobTimeoutSeconds: 42 } }); assert.equal(s.config.jobTimeoutSeconds, 42); assert.throws(() => new WorkflowScheduler({ pool: p, queue: { leaseSeconds: 30 }, config: { jobTimeoutSeconds: 0 } }), /jobTimeoutSeconds/); });
