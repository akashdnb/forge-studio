'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({ leaseMs: 30_000, waitMs: 0, pollMs: 50, maxLeaseMs: 5 * 60_000, priority: 0 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function int(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`); return n; }
function required(value, name) { if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new TypeError(`${name} must be a non-empty string <= 512 characters`); return value; }

class LockNotHeldError extends Error {
  constructor(message = 'Distributed lock is no longer held by this owner') { super(message); this.name = 'LockNotHeldError'; this.code = 'COORDINATION_FENCE_LOST'; this.retryable = false; }
}

class DistributedLock {
  constructor({ pool, clock = () => new Date(), ownerId = process.env.FORGE_WORKER_ID || `forge:${randomUUID()}`, metrics = null, logger = console } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('A pg-compatible pool is required');
    this.pool = pool; this.clock = clock; this.ownerId = required(ownerId, 'ownerId'); this.metrics = metrics; this.logger = logger;
  }
  async _tx(fn) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); } }
  async acquire({ scopeKey, tenantId = null, projectId = null, purpose = 'unspecified', resourceVersion = null, leaseMs = DEFAULTS.leaseMs, waitMs = DEFAULTS.waitMs, pollMs = DEFAULTS.pollMs, priority = DEFAULTS.priority, waitPolicy = 'bounded', ownerId = this.ownerId, metadata = {} } = {}) {
    required(scopeKey, 'scopeKey'); required(purpose, 'purpose'); required(ownerId, 'ownerId'); leaseMs = int('leaseMs', leaseMs, { min: 100, max: DEFAULTS.maxLeaseMs }); waitMs = int('waitMs', waitMs, { min: 0, max: 10 * 60_000 }); pollMs = int('pollMs', pollMs, { min: 10, max: 5_000 }); priority = int('priority', priority, { min: -1_000_000, max: 1_000_000 });
    const deadline = Date.now() + waitMs; let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const result = await this._tx(async (client) => {
          const remaining = Math.max(25, Math.min(pollMs, Math.max(25, deadline - Date.now())));
          await client.query(`SET LOCAL lock_timeout = '${remaining}ms'`);
          const existing = await client.query("SELECT *, (state='HELD' AND expires_at>clock_timestamp()) AS coordination_active FROM forge_coordination_locks WHERE scope_key=$1 FOR UPDATE", [scopeKey]);
          const row = existing.rows[0];
          if (!row) {
            const inserted = await client.query(`INSERT INTO forge_coordination_locks
              (scope_key,tenant_id,project_id,owner_id,fencing_token,epoch,acquired_at,expires_at,last_renewed_at,wait_policy,priority,purpose,resource_version,state,metadata,updated_at)
              VALUES($1,$2,$3,$4,1,1,clock_timestamp(),clock_timestamp()+($5::text||' milliseconds')::interval,clock_timestamp(),$6,$7,$8,$9,'HELD',$10::jsonb,clock_timestamp()) RETURNING *`, [scopeKey, tenantId, projectId, ownerId, leaseMs, waitPolicy, priority, purpose, resourceVersion, JSON.stringify(metadata)]);
            await this._audit(client, inserted.rows[0], 'ACQUIRED', { attempts }); return this._lease(inserted.rows[0]);
          }
          if (row.coordination_active) return { acquired: false, code: 'LOCK_BUSY', holder: this._public(row) };
          const token = BigInt(row.fencing_token || 0) + 1n; const epoch = BigInt(row.epoch || 0) + 1n;
          const updated = await client.query(`UPDATE forge_coordination_locks SET tenant_id=$2,project_id=$3,owner_id=$4,fencing_token=$5,epoch=$6,acquired_at=clock_timestamp(),expires_at=clock_timestamp()+($7::text||' milliseconds')::interval,last_renewed_at=clock_timestamp(),wait_policy=$8,priority=$9,purpose=$10,resource_version=$11,state='HELD',metadata=$12::jsonb,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id, tenantId, projectId, ownerId, token.toString(), epoch.toString(), leaseMs, waitPolicy, priority, purpose, resourceVersion, JSON.stringify(metadata)]);
          await this._audit(client, updated.rows[0], row.state === 'HELD' ? 'RECOVERED_EXPIRED' : 'ACQUIRED', { attempts, previousOwner: row.owner_id, previousToken: row.fencing_token }); return this._lease(updated.rows[0]);
        });
        if (result.acquired !== false) { this._metric('acquire', 'success'); return result; }
        this._metric('acquire', 'busy'); if (Date.now() >= deadline || waitMs === 0) return result;
      } catch (error) {
        if (!['55P03', '40P01', '40001', '23505'].includes(error.code)) throw error;
        this._metric('acquire', 'retry'); if (Date.now() >= deadline) return { acquired: false, code: 'LOCK_WAIT_TIMEOUT', attempts, lastError: error.code };
      }
      await sleep(Math.min(pollMs, Math.max(10, deadline - Date.now())));
    }
  }
  async renew(lease, { leaseMs = DEFAULTS.leaseMs } = {}) {
    this._assertLease(lease); leaseMs = int('leaseMs', leaseMs, { min: 100, max: DEFAULTS.maxLeaseMs });
    const result = await this.pool.query(`UPDATE forge_coordination_locks SET expires_at=clock_timestamp()+($5::text||' milliseconds')::interval,last_renewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE scope_key=$1 AND owner_id=$2 AND fencing_token=$3 AND epoch=$4 AND state='HELD' AND expires_at>clock_timestamp() RETURNING *`, [lease.scopeKey, lease.ownerId, lease.fencingToken, lease.epoch, leaseMs]);
    if (!result.rows[0]) { this._metric('renew', 'lost'); throw new LockNotHeldError(); }
    this._metric('renew', 'success'); return this._lease(result.rows[0]);
  }
  async release(lease, { reason = 'released' } = {}) {
    this._assertLease(lease);
    const result = await this._tx(async (client) => {
      const current = await client.query('SELECT * FROM forge_coordination_locks WHERE scope_key=$1 FOR UPDATE', [lease.scopeKey]); const row = current.rows[0];
      if (!row) return { released: true, idempotent: true, code: 'ALREADY_RELEASED' };
      if (String(row.fencing_token) !== String(lease.fencingToken) || String(row.epoch) !== String(lease.epoch) || row.owner_id !== lease.ownerId) return { released: false, idempotent: true, code: 'SUPERSEDED' };
      if (row.state === 'RELEASED') return { released: true, idempotent: true, code: 'ALREADY_RELEASED' };
      const updated = await client.query(`UPDATE forge_coordination_locks SET state='RELEASED',expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id]); await this._audit(client, updated.rows[0], 'RELEASED', { reason }); return { released: true, idempotent: false, code: 'RELEASED' };
    });
    this._metric('release', result.released ? 'success' : 'superseded'); return result;
  }
  async assertHeld(lease, { client = null, resourceVersion = undefined } = {}) {
    this._assertLease(lease); const runner = client || this.pool; const params = [lease.scopeKey, lease.ownerId, lease.fencingToken, lease.epoch]; let sql = `SELECT * FROM forge_coordination_locks WHERE scope_key=$1 AND owner_id=$2 AND fencing_token=$3 AND epoch=$4 AND state='HELD' AND expires_at>clock_timestamp()`;
    if (resourceVersion !== undefined) { params.push(resourceVersion); sql += ` AND resource_version=$${params.length}`; }
    const result = await runner.query(sql, params); if (!result.rows[0]) { this._metric('fence', 'rejected'); throw new LockNotHeldError(); } this._metric('fence', 'accepted'); return result.rows[0];
  }
  async inspect({ scopeKey = null, tenantId = null, projectId = null, includeReleased = false, limit = 100 } = {}) {
    limit = int('limit', limit, { min: 1, max: 500 }); const where = [], params = []; if (scopeKey) { params.push(scopeKey); where.push(`scope_key=$${params.length}`); } if (tenantId) { params.push(tenantId); where.push(`tenant_id=$${params.length}`); } if (projectId) { params.push(projectId); where.push(`project_id=$${params.length}`); } if (!includeReleased) where.push(`state='HELD'`); params.push(limit);
    const result = await this.pool.query(`SELECT *, (state='HELD' AND expires_at<=clock_timestamp()) AS coordination_expired FROM forge_coordination_locks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC,expires_at ASC LIMIT $${params.length}`, params); return result.rows.map((row) => ({ ...this._public(row), expired: row.coordination_expired === true }));
  }
  async recoverExpired({ scopeKey, reason = 'operator_recovery' } = {}) {
    required(scopeKey, 'scopeKey'); return this._tx(async (client) => { const current = await client.query("SELECT *, (state='HELD' AND expires_at<=clock_timestamp()) AS coordination_expired FROM forge_coordination_locks WHERE scope_key=$1 FOR UPDATE", [scopeKey]); const row = current.rows[0]; if (!row) return { recovered: false, code: 'NOT_FOUND' }; if (!row.coordination_expired) return { recovered: false, code: 'NOT_EXPIRED', lock: this._public(row) }; const updated = await client.query(`UPDATE forge_coordination_locks SET state='RELEASED',expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id]); await this._audit(client, updated.rows[0], 'FORCE_RECOVERED', { reason, previousOwner: row.owner_id, previousToken: row.fencing_token }); this._metric('recover', 'success'); return { recovered: true, lock: this._public(updated.rows[0]) }; });
  }
  async health() { const result = await this.pool.query(`SELECT count(*) FILTER(WHERE state='HELD')::int held,count(*) FILTER(WHERE state='HELD' AND expires_at<=clock_timestamp())::int expired,count(*)::int total FROM forge_coordination_locks`); return { status: 'ok', ...result.rows[0] }; }
  _assertLease(lease) { if (!lease || !lease.scopeKey || lease.fencingToken == null || lease.epoch == null || !lease.ownerId) throw new TypeError('A valid coordination lease is required'); }
  _lease(row) { return { acquired: true, id: row.id, scopeKey: row.scope_key, tenantId: row.tenant_id, projectId: row.project_id, ownerId: row.owner_id, fencingToken: String(row.fencing_token), epoch: String(row.epoch), acquiredAt: row.acquired_at, expiresAt: row.expires_at, lastRenewedAt: row.last_renewed_at, resourceVersion: row.resource_version, purpose: row.purpose, priority: row.priority, metadata: row.metadata }; }
  _public(row) { return { id: row.id, scopeKey: row.scope_key, tenantId: row.tenant_id, projectId: row.project_id, ownerId: row.owner_id, fencingToken: String(row.fencing_token), epoch: String(row.epoch), acquiredAt: row.acquired_at, expiresAt: row.expires_at, lastRenewedAt: row.last_renewed_at, state: row.state, resourceVersion: row.resource_version, purpose: row.purpose, priority: row.priority, waitPolicy: row.wait_policy, metadata: row.metadata }; }
  async _audit(client, row, eventType, details) { await client.query(`INSERT INTO forge_coordination_audit(lock_id,scope_key,tenant_id,project_id,event_type,owner_id,fencing_token,epoch,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [row.id,row.scope_key,row.tenant_id,row.project_id,eventType,row.owner_id,row.fencing_token,row.epoch,JSON.stringify(details||{})]); }
  _metric(operation, outcome) { try { this.metrics?.inc?.(`forge_coordination_${operation}_total`, { outcome }); } catch (error) { this.logger.debug?.({ event: 'coordination.metric_failed', error: error.message }); } }
}

async function withFencedLock(coordinator, options, operation) {
  const lease = await coordinator.acquire(options); if (!lease.acquired) { const error = new Error(`Coordination lock unavailable: ${lease.code}`); error.code = lease.code; error.retryable = true; throw error; }
  let heartbeat = null; try { await coordinator.assertHeld(lease); const renewalMs = Math.max(100, Math.floor((new Date(lease.expiresAt).getTime() - Date.now()) / 3)); heartbeat = setInterval(() => coordinator.renew(lease, options).catch(() => {}), renewalMs); heartbeat.unref?.(); return await operation({ lease, fence: (args) => coordinator.assertHeld(lease, args) }); }
  finally { if (heartbeat) clearInterval(heartbeat); await coordinator.release(lease).catch(() => {}); }
}

module.exports = { DistributedLock, LockNotHeldError, withFencedLock };
