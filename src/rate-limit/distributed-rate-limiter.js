'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');

const DEFAULTS = Object.freeze({
  sustainedRate: 120,
  burstCapacity: 60,
  concurrencyLimit: 32,
  priority: 100,
  maxClockStepSeconds: 30,
  defaultMode: 'ENFORCE',
  defaultFailMode: 'FAIL_CLOSED',
});

const VALID_MODES = new Set(['ENFORCE', 'SHADOW', 'DISABLED']);
const VALID_FAIL_MODES = new Set(['FAIL_CLOSED', 'FAIL_OPEN']);
const VALID_SCOPES = new Set(['GLOBAL', 'TENANT', 'PROJECT']);

function boundedString(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw Object.assign(new TypeError(`${name} is invalid`), { code: 'RATE_LIMIT_INVALID' });
  }
  return value;
}

function positiveNumber(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw Object.assign(new TypeError(`${name} is invalid`), { code: 'RATE_LIMIT_INVALID' });
  }
  return n;
}

function canonicalRouteClass(method, rawPath) {
  const pathname = new URL(rawPath || '/', 'http://localhost').pathname;
  const m = String(method || 'GET').toUpperCase();
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'v1' || parts[0] === 'v2') parts.shift();
  if (!parts.length) return `${m}:root`;
  const first = parts[0].toLowerCase();
  const known = new Map([
    ['projects', 'projects'], ['episodes', 'episodes'], ['versions', 'versions'],
    ['artifacts', 'artifacts'], ['jobs', 'jobs'], ['usage', 'usage'],
    ['reviews', 'reviews'], ['search', 'search'], ['evidence', 'evidence'],
    ['provider-runs', 'provider-runs'], ['bundles', 'bundles'],
  ]);
  const resource = known.get(first) || first.replace(/[^a-z0-9_-]/g, '').slice(0, 48) || 'unknown';
  const second = parts[1] ? parts[1].toLowerCase() : '';
  if (second && /^[a-z0-9_-]{1,64}$/.test(second) && !['health', 'metrics', 'diagnostics', 'export', 'import', 'replay', 'workflow', 'render', 'qa', 'research', 'timeline', 'costs', 'publish'].includes(second)) {
    return `${m}:${resource}:item`;
  }
  return `${m}:${resource}${second ? `:${second.replace(/[^a-z0-9_-]/g, '').slice(0, 32)}` : ''}`.slice(0, 96);
}

function scopeKey(scope, tenantId, projectId) {
  if (scope === 'GLOBAL') return 'global';
  if (scope === 'TENANT') return `tenant:${tenantId}`;
  return `project:${projectId}`;
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function retryAfterSeconds(seconds) {
  return Math.max(1, Math.ceil(Number(seconds) || 1));
}

class DistributedRateLimitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DistributedRateLimitError';
    this.code = code;
    this.statusCode = code === 'RATE_LIMITED' ? 429 : 503;
    this.details = details;
  }
}

class DistributedRateLimiter {
  constructor({ pool, now = null, logger = console, metrics = null } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('pg pool is required');
    this.pool = pool;
    this.now = now;
    this.logger = logger;
    this.metrics = metrics || { allowed: 0, denied: 0, unavailable: 0, reused: 0, bypassed: 0, active: 0 };
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async dbNow(client) {
    if (this.now) return new Date(this.now());
    return (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
  }

  async resolveProjectId({ tenantId, pathname, query = null }) {
    if (!tenantId) return null;
    const parts = pathname.split('/').filter(Boolean);
    if (query?.projectId) {
      const row = (await this.pool.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2', [query.projectId, tenantId])).rows[0];
      return row?.id || null;
    }
    if ((parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'projects' && parts[2]) return parts[2];
    if ((parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'episodes' && parts[2]) {
      return (await this.pool.query('SELECT p.id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1 AND p.tenant_id=$2', [parts[2], tenantId])).rows[0]?.id || null;
    }
    if ((parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'versions' && parts[2]) {
      return (await this.pool.query('SELECT p.id FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE v.id=$1 AND p.tenant_id=$2', [parts[2], tenantId])).rows[0]?.id || null;
    }
    if ((parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'artifacts' && parts[2]) {
      return (await this.pool.query('SELECT p.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1 AND p.tenant_id=$2', [parts[2], tenantId])).rows[0]?.id || null;
    }
    if ((parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'jobs' && parts[2]) {
      return (await this.pool.query('SELECT p.id FROM forge_jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND p.tenant_id=$2', [parts[2], tenantId])).rows[0]?.id || null;
    }
    return null;
  }

  async effectivePolicies({ tenantId, projectId, method, routeClass }) {
    const rows = await this.pool.query(`
      SELECT p.*
      FROM forge_rate_limit_policies p
      WHERE p.active=true
        AND p.method=$1
        AND (p.route_class=$2 OR p.route_class='*')
        AND ((p.scope_type='GLOBAL' AND p.tenant_id IS NULL AND p.project_id IS NULL)
          OR (p.scope_type='TENANT' AND p.tenant_id=$3 AND p.project_id IS NULL)
          OR (p.scope_type='PROJECT' AND p.project_id=$4))
      ORDER BY CASE p.scope_type WHEN 'GLOBAL' THEN 1 WHEN 'TENANT' THEN 2 ELSE 3 END,
               CASE WHEN p.route_class='*' THEN 0 ELSE 1 END,
               p.effective_version DESC`,
      [method, routeClass, tenantId, projectId || null]);
    return rows.rows;
  }

  async activeOverrides({ tenantId, projectId, method, routeClass }) {
    return (await this.pool.query(`
      SELECT * FROM forge_rate_limit_overrides
      WHERE active=true AND expires_at>clock_timestamp()
        AND method=$1 AND (route_class=$2 OR route_class='*')
        AND ((scope_type='GLOBAL' AND tenant_id IS NULL AND project_id IS NULL)
          OR (scope_type='TENANT' AND tenant_id=$3 AND project_id IS NULL)
          OR (scope_type='PROJECT' AND project_id=$4))
      ORDER BY created_at DESC`, [method, routeClass, tenantId, projectId || null])).rows;
  }

  mergePolicy(policy, override) {
    if (!override) return policy;
    return {
      ...policy,
      sustained_rate: override.sustained_rate,
      burst_capacity: override.burst_capacity,
      concurrency_limit: override.concurrency_limit,
      priority: override.priority,
      enforcement_mode: override.enforcement_mode,
      fail_mode: override.fail_mode,
      effective_version: Math.max(Number(policy.effective_version), Number(override.effective_version || policy.effective_version)),
      override_id: override.id,
    };
  }

  async check({ tenantId = null, projectId = null, method, pathname, requestKey, cost = 1, trustedBypassScope = null }) {
    const routeClass = canonicalRouteClass(method, pathname);
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const key = boundedString(requestKey || hashKey(`${normalizedMethod}:${pathname}:${Date.now()}`), 'requestKey', 256);
    const amount = positiveNumber(cost, 'cost', 1, 100);
    try {
      return await this.tx(async client => {
        const policies = await this.effectivePolicies({ tenantId, projectId, method: normalizedMethod, routeClass });
        const overrides = await this.activeOverrides({ tenantId, projectId, method: normalizedMethod, routeClass });
        const effective = policies.map(p => this.mergePolicy(p, overrides.find(o => (o.scope_type === p.scope_type && (o.scope_type === 'GLOBAL' || o.project_id === p.project_id || o.tenant_id === p.tenant_id)) || o.route_class === p.route_class)));
        const enforceable = effective.filter(p => p.enforcement_mode !== 'DISABLED');
        if (!enforceable.length) return { allowed: true, routeClass, policies: [] };
        if (trustedBypassScope && effective.every(p => (p.trusted_bypass_scope || '') === trustedBypassScope || p.enforcement_mode === 'SHADOW')) {
          this.metrics.bypassed += 1;
          await client.query(`INSERT INTO forge_rate_limit_audit(tenant_id,project_id,request_key,method,route_class,outcome,reason,policy_versions,metadata) VALUES($1,$2,$3,$4,$5,'BYPASSED','trusted_internal_scope',$6::jsonb,$7::jsonb)`, [tenantId, projectId, key, normalizedMethod, routeClass, JSON.stringify(effective.map(p => p.effective_version)), JSON.stringify({ scope: trustedBypassScope })]);
          return { allowed: true, bypassed: true, routeClass, policies: effective };
        }
        const existing = (await client.query('SELECT * FROM forge_rate_limit_requests WHERE request_key=$1 FOR UPDATE', [key])).rows[0];
        if (existing) {
          this.metrics.reused += 1;
          return { allowed: existing.outcome !== 'DENIED', reused: true, routeClass, retryAfter: Number(existing.retry_after_seconds || 0), requestId: existing.request_key };
        }
        const dbNow = await this.dbNow(client);
        const decisions = [];
        for (const policy of enforceable) {
          const scope = scopeKey(policy.scope_type, tenantId, projectId);
          const lockKey = `forge-rate:${policy.id}:${scope}:${normalizedMethod}:${routeClass}`;
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
          const bucketKey = `${policy.id}:${scope}:${normalizedMethod}:${routeClass}`;
          const row = (await client.query('SELECT * FROM forge_rate_limit_buckets WHERE bucket_key=$1 FOR UPDATE', [bucketKey])).rows[0];
          const rate = positiveNumber(policy.sustained_rate, 'sustained_rate', 0, 1e9);
          const burst = positiveNumber(policy.burst_capacity, 'burst_capacity', 0, 1e9);
          const previous = row ? Number(row.tokens) : burst;
          const last = row ? new Date(row.last_refill_at).getTime() : new Date(dbNow).getTime();
          const elapsed = Math.min(Math.max(0, new Date(dbNow).getTime() - last) / 1000, DEFAULTS.maxClockStepSeconds * 3600);
          const replenished = Math.min(burst, previous + elapsed * rate);
          const available = replenished >= amount;
          const nextTokens = available ? replenished - amount : replenished;
          const retryAfter = available || rate <= 0 ? 0 : retryAfterSeconds((amount - replenished) / rate);
          const activeConcurrency = Number(row?.active_concurrency || 0);
          const concurrencyLimit = Number(policy.concurrency_limit || 0);
          const concurrencyOk = concurrencyLimit <= 0 || activeConcurrency < concurrencyLimit;
          decisions.push({ policy, bucketKey, available, nextTokens, retryAfter, activeConcurrency, concurrencyLimit, concurrencyOk });
        }
        const denied = decisions.find(d => d.policy.enforcement_mode === 'ENFORCE' && (!d.available || !d.concurrencyOk));
        const retryAfter = denied ? Math.max(denied.retryAfter, denied.concurrencyOk ? 0 : 1) : 0;
        const outcome = denied ? 'DENIED' : (decisions.some(d => d.policy.enforcement_mode === 'SHADOW' && (!d.available || !d.concurrencyOk)) ? 'SHADOW' : 'ALLOWED');
        for (const decision of decisions) {
          const { policy, bucketKey, nextTokens } = decision;
          const consume = policy.enforcement_mode === 'ENFORCE' ? decision.available && decision.concurrencyOk : false;
          const tokenValue = consume ? nextTokens : (row => row)(decision.nextTokens);
          await client.query(`INSERT INTO forge_rate_limit_buckets(bucket_key,policy_id,scope_type,tenant_id,project_id,route_class,method,tokens,last_refill_at,active_concurrency,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,${consume ? '1' : '0'},clock_timestamp()) ON CONFLICT(bucket_key) DO UPDATE SET tokens=$8,last_refill_at=$9,active_concurrency=forge_rate_limit_buckets.active_concurrency+${consume ? '1' : '0'},updated_at=clock_timestamp()`, [bucketKey, policy.id, policy.scope_type, tenantId, projectId, routeClass, normalizedMethod, tokenValue, dbNow]);
        }
        await client.query(`INSERT INTO forge_rate_limit_requests(request_key,tenant_id,project_id,method,route_class,outcome,token_cost,retry_after_seconds,policy_versions,started_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)`, [key, tenantId, projectId, normalizedMethod, routeClass, outcome, amount, retryAfter, JSON.stringify(effective.map(p => Number(p.effective_version))), dbNow, JSON.stringify({ shadow: outcome === 'SHADOW' })]);
        await client.query(`INSERT INTO forge_rate_limit_audit(tenant_id,project_id,request_key,method,route_class,outcome,reason,policy_versions,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [tenantId, projectId, key, normalizedMethod, routeClass, outcome, denied ? (denied.concurrencyOk ? 'burst_exhausted' : 'concurrency_exhausted') : null, JSON.stringify(effective.map(p => Number(p.effective_version))), JSON.stringify({ retryAfter })]);
        if (denied) {
          this.metrics.denied += 1;
          throw new DistributedRateLimitError('RATE_LIMITED', 'Request rate or concurrency limit exceeded', { retryAfter, routeClass, policyVersion: denied.policy.effective_version });
        }
        this.metrics.allowed += 1;
        return { allowed: true, routeClass, retryAfter: 0, reused: false, requestKey: key, policies: effective };
      });
    } catch (error) {
      if (error instanceof DistributedRateLimitError) throw error;
      this.metrics.unavailable += 1;
      const failClosed = await this.shouldFailClosed({ tenantId, projectId, method: normalizedMethod, pathname }).catch(() => true);
      if (failClosed) throw new DistributedRateLimitError('RATE_LIMIT_UNAVAILABLE', 'Distributed rate-limit storage is unavailable', { cause: error.code || error.message });
      this.logger.error?.({ event: 'rate_limit.fail_open', tenantId, projectId, routeClass, error: error.message });
      return { allowed: true, failOpen: true, routeClass };
    }
  }

  async shouldFailClosed({ tenantId, projectId, method, pathname }) {
    const routeClass = canonicalRouteClass(method, pathname);
    const rows = await this.pool.query(`SELECT fail_mode FROM forge_rate_limit_policies WHERE active=true AND method=$1 AND (route_class=$2 OR route_class='*') AND ((scope_type='TENANT' AND tenant_id=$3) OR (scope_type='PROJECT' AND project_id=$4) OR scope_type='GLOBAL') ORDER BY CASE scope_type WHEN 'GLOBAL' THEN 1 WHEN 'TENANT' THEN 2 ELSE 3 END, effective_version DESC`, [method, routeClass, tenantId, projectId || null]);
    return rows.rows.some(r => r.fail_mode === 'FAIL_CLOSED') || rows.rows.length === 0;
  }

  async release({ requestKey }) {
    return this.tx(async client => {
      const request = (await client.query('SELECT * FROM forge_rate_limit_requests WHERE request_key=$1 FOR UPDATE', [requestKey])).rows[0];
      if (!request || request.outcome === 'DENIED' || request.released_at) return false;
      const policies = JSON.parse(request.policy_versions || '[]');
      for (const policyId of policies) {
        await client.query('UPDATE forge_rate_limit_buckets SET active_concurrency=GREATEST(0,active_concurrency-1),updated_at=clock_timestamp() WHERE policy_id=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND project_id IS NOT DISTINCT FROM $3 AND route_class=$4 AND method=$5 AND active_concurrency>0', [policyId, request.tenant_id, request.project_id, request.route_class, request.method]);
      }
      await client.query('UPDATE forge_rate_limit_requests SET released_at=clock_timestamp() WHERE request_key=$1 AND released_at IS NULL', [requestKey]);
      return true;
    });
  }

  async reset({ tenantId, projectId = null, routeClass = '*', actor, reason }) {
    return this.tx(async client => {
      await client.query('UPDATE forge_rate_limit_buckets SET tokens=0,active_concurrency=0,last_refill_at=clock_timestamp(),updated_at=clock_timestamp() WHERE (tenant_id=$1 OR $1 IS NULL) AND (project_id=$2 OR $2 IS NULL) AND (route_class=$3 OR $3='*')', [tenantId, projectId, routeClass]);
      await client.query(`INSERT INTO forge_rate_limit_audit(tenant_id,project_id,request_key,method,route_class,outcome,reason,policy_versions,metadata) VALUES($1,$2,NULL,'*',$3,'RESET',$4,'[]'::jsonb,$5::jsonb)`, [tenantId, projectId, routeClass, reason || 'operator reset', JSON.stringify({ actor })]);
      return { reset: true };
    });
  }

  async upsertPolicy(input) {
    const scopeType = String(input.scopeType || 'TENANT').toUpperCase();
    if (!VALID_SCOPES.has(scopeType)) throw new TypeError('invalid scopeType');
    const method = String(input.method || '*').toUpperCase();
    const routeClass = boundedString(input.routeClass || '*', 'routeClass', 96);
    const sustainedRate = positiveNumber(input.sustainedRate ?? DEFAULTS.sustainedRate, 'sustainedRate', 0, 1e9);
    const burstCapacity = positiveNumber(input.burstCapacity ?? DEFAULTS.burstCapacity, 'burstCapacity', 0, 1e9);
    const concurrencyLimit = positiveNumber(input.concurrencyLimit ?? DEFAULTS.concurrencyLimit, 'concurrencyLimit', 0, 1e9);
    const priority = positiveNumber(input.priority ?? DEFAULTS.priority, 'priority', 0, 100000);
    const enforcementMode = String(input.enforcementMode || DEFAULTS.defaultMode).toUpperCase();
    const failMode = String(input.failMode || DEFAULTS.defaultFailMode).toUpperCase();
    if (!VALID_MODES.has(enforcementMode) || !VALID_FAIL_MODES.has(failMode)) throw new TypeError('invalid enforcement/fail mode');
    if (scopeType === 'TENANT' && !input.tenantId) throw new TypeError('tenantId required for TENANT policy');
    if (scopeType === 'PROJECT' && !input.projectId) throw new TypeError('projectId required for PROJECT policy');
    return this.tx(async client => {
      if (scopeType === 'PROJECT') {
        const row = (await client.query('SELECT tenant_id FROM projects WHERE id=$1', [input.projectId])).rows[0];
        if (!row || (input.tenantId && row.tenant_id !== input.tenantId)) throw Object.assign(new Error('project/tenant mismatch'), { code: 'TENANT_ISOLATION', statusCode: 403 });
      }
      const current = (await client.query(`SELECT * FROM forge_rate_limit_policies WHERE active=true AND scope_type=$1 AND method=$2 AND route_class=$3 AND tenant_id IS NOT DISTINCT FROM $4 AND project_id IS NOT DISTINCT FROM $5 ORDER BY effective_version DESC LIMIT 1 FOR UPDATE`, [scopeType, method, routeClass, input.tenantId || null, input.projectId || null])).rows[0];
      const version = Number(current?.effective_version || 0) + 1;
      if (current) await client.query('UPDATE forge_rate_limit_policies SET active=false,updated_at=clock_timestamp() WHERE id=$1', [current.id]);
      const inserted = (await client.query(`INSERT INTO forge_rate_limit_policies(scope_type,tenant_id,project_id,plan_version,route_class,method,sustained_rate,burst_capacity,concurrency_limit,priority,enforcement_mode,fail_mode,effective_version,trusted_bypass_scope,metadata,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING *`, [scopeType, input.tenantId || null, input.projectId || null, input.planVersion || 'default', routeClass, method, sustainedRate, burstCapacity, concurrencyLimit, priority, enforcementMode, failMode, version, input.trustedBypassScope || null, JSON.stringify(input.metadata || {}), input.actor || 'operator'])).rows[0];
      await client.query(`INSERT INTO forge_rate_limit_policy_history(policy_id,tenant_id,project_id,effective_version,snapshot,actor,request_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [inserted.id, inserted.tenant_id, inserted.project_id, version, JSON.stringify(inserted), input.actor || 'operator', input.requestId || null]);
      await client.query(`INSERT INTO forge_rate_limit_audit(tenant_id,project_id,request_key,method,route_class,outcome,reason,policy_versions,metadata) VALUES($1,$2,NULL,$3,$4,'POLICY_UPDATE','policy_update',$5::jsonb,$6::jsonb)`, [inserted.tenant_id, inserted.project_id, method, routeClass, JSON.stringify([version]), JSON.stringify({ actor: input.actor || 'operator', planVersion: inserted.plan_version })]);
      return inserted;
    });
  }

  async listPolicies({ tenantId, projectId = null }) {
    const rows = await this.pool.query(`SELECT * FROM forge_rate_limit_policies WHERE active=true AND ($1::text IS NULL OR tenant_id=$1) AND ($2::text IS NULL OR project_id=$2) ORDER BY scope_type,route_class,method,effective_version DESC`, [tenantId || null, projectId || null]);
    return rows.rows;
  }

  async usage({ tenantId, projectId = null }) {
    const rows = await this.pool.query(`SELECT tenant_id,project_id,route_class,method,sum(CASE WHEN outcome='ALLOWED' THEN 1 ELSE 0 END)::bigint allowed,sum(CASE WHEN outcome='DENIED' THEN 1 ELSE 0 END)::bigint denied,count(*)::bigint total,max(started_at) last_request FROM forge_rate_limit_requests WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2) AND started_at>clock_timestamp()-interval '1 hour' GROUP BY tenant_id,project_id,route_class,method ORDER BY total DESC`, [tenantId, projectId || null]);
    return rows.rows;
  }

  async health() {
    const started = Date.now();
    await this.pool.query('SELECT clock_timestamp()');
    return { status: 'ok', latencyMs: Date.now() - started, storage: 'postgresql' };
  }
}

module.exports = { DistributedRateLimiter, DistributedRateLimitError, canonicalRouteClass, retryAfterSeconds, DEFAULTS };
