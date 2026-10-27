'use strict';

const { randomUUID } = require('node:crypto');

const SEARCH_DAYS = 370;
const MINUTES_PER_DAY = 1440;
const WEEKDAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

function validTimeZone(zone) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; } }
function parts(date, timeZone) { const out = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value); return out; }
function pad(n) { return String(n).padStart(2, '0'); }
function localDate(p) { return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
function naiveLocal(p) { return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0); }
function parseLocalDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new TypeError('local date must be YYYY-MM-DD'); const [y, m, d] = value.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d)); if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) throw new TypeError('invalid local date'); return { year: y, month: m, day: d }; }
function addLocalDays(value, count) { const [y, m, d] = value.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10); }

function resolveLocalDateTime(local, zone, gapPolicy = 'SKIP', foldPolicy = 'EARLIER') {
  const target = parseLocalDate(local.date);
  if (!Number.isInteger(local.hour) || local.hour < 0 || local.hour > 23 || !Number.isInteger(local.minute) || local.minute < 0 || local.minute > 59) throw new TypeError('invalid local time');
  const naive = Date.UTC(target.year, target.month - 1, target.day, local.hour, local.minute);
  const matches = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 1) {
    const candidate = new Date(naive - offset * 60000);
    const p = parts(candidate, zone);
    if (p.year === target.year && p.month === target.month && p.day === target.day && p.hour === local.hour && p.minute === local.minute) matches.push(candidate);
  }
  matches.sort((a, b) => a - b);
  if (matches.length) return foldPolicy === 'LATER' ? [matches[matches.length - 1]] : foldPolicy === 'BOTH' ? matches : [matches[0]];
  if (gapPolicy === 'SKIP') return [];
  for (let minute = 1; minute <= 240; minute += 1) {
    const probe = new Date(naive + minute * 60000);
    const p = parts(probe, zone);
    const candidateLocal = naiveLocal(p);
    if (candidateLocal >= naive && p.year === target.year && p.month === target.month && p.day === target.day) return [probe];
  }
  return [];
}

function tokenValue(token, map) { const upper = token.toUpperCase(); if (Object.prototype.hasOwnProperty.call(map, upper)) return map[upper]; const n = Number(token); if (!Number.isInteger(n)) throw new TypeError(`invalid cron token ${token}`); return n; }
function parseField(field, min, max, map = {}) {
  if (!field || field === '?') throw new TypeError('empty cron field');
  const values = new Set();
  for (const raw of field.split(',')) {
    const [base, stepRaw] = raw.split('/'); const step = stepRaw == null ? 1 : Number(stepRaw); if (!Number.isInteger(step) || step < 1) throw new TypeError(`invalid cron step ${raw}`);
    let start; let end;
    if (base === '*') { start = min; end = max; } else if (base.includes('-')) { const [a, b] = base.split('-'); start = tokenValue(a, map); end = tokenValue(b, map); } else { start = tokenValue(base, map); end = stepRaw == null ? start : max; }
    if (start < min || end > max || start > end) throw new TypeError(`cron value out of range ${raw}`);
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
function parseCron(expression) {
  const aliases = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
  const expr = aliases[String(expression || '').trim().toLowerCase()] || String(expression || '').trim();
  const f = expr.split(/\s+/); if (f.length !== 5) throw new TypeError('cron must contain five fields: minute hour day-of-month month day-of-week');
  return { expression: expr, minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), month: parseField(f[3], 1, 12, MONTHS), dow: parseField(f[4], 0, 7, WEEKDAYS), domWildcard: f[2] === '*', dowWildcard: f[4] === '*' };
}
function cronMatches(c, p) {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  const dow = p.day === 0 ? 0 : new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const dom = c.dom.has(p.day); const week = c.dow.has(dow) || (dow === 0 && c.dow.has(7));
  if (!c.domWildcard && !c.dowWildcard) return dom || week;
  return dom && week;
}
function nextCronOccurrence(expression, after, zone, gapPolicy = 'SKIP', foldPolicy = 'EARLIER') {
  if (!validTimeZone(zone)) throw new TypeError(`invalid IANA timezone: ${zone}`);
  const cron = parseCron(expression); const start = parts(after, zone); const startDate = localDate(start);
  for (let day = 0; day <= SEARCH_DAYS; day += 1) {
    const date = addLocalDays(startDate, day); const d = parseLocalDate(date);
    for (const hour of cron.hour) {
      if (day === 0 && hour < start.hour) continue;
      for (const minute of cron.minute) {
        if (day === 0 && (hour < start.hour || (hour === start.hour && minute <= start.minute))) continue;
        const p = { ...d, hour, minute };
        if (!cronMatches(cron, p)) continue;
        const candidates = resolveLocalDateTime({ date, hour, minute }, zone, gapPolicy, foldPolicy);
        for (const instant of candidates.sort((a, b) => a - b)) if (instant > after) return { instant, localDate: date, localHour: hour, localMinute: minute, ambiguous: candidates.length > 1, dstAdjusted: candidates.length === 1 && !parts(instant, zone).hour === hour };
      }
    }
  }
  throw Object.assign(new Error('cron search horizon exhausted'), { code: 'SCHEDULE_EXHAUSTED' });
}

function nextFire(spec, after) {
  if (!validTimeZone(spec.timezone)) throw new TypeError(`invalid IANA timezone: ${spec.timezone}`);
  if (spec.triggerType === 'ONCE' || spec.triggerType === 'DELAY') { const instant = new Date(spec.fireAt); return instant > after ? { instant, localDate: localDate(parts(instant, spec.timezone)) } : null; }
  return nextCronOccurrence(spec.cronExpr, after, spec.timezone, spec.dstGapPolicy, spec.dstFoldPolicy);
}

function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; }

class DurableScheduler {
  constructor({ pool, schedulerId = `durable-scheduler:${randomUUID()}`, clock = () => new Date(), leaseSeconds = 30, logger = console } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    this.pool = pool; this.schedulerId = schedulerId; this.clock = clock; this.leaseSeconds = leaseSeconds; this.logger = logger; this.fencingEpoch = null;
  }

  async heartbeat() {
    const c = await this.pool.connect();
    try { await c.query('BEGIN');
      const control = (await c.query('UPDATE forge_scheduler_control SET fencing_epoch=fencing_epoch+1,updated_at=clock_timestamp() WHERE id=true RETURNING fencing_epoch')).rows[0];
      const epoch = Number(control.fencing_epoch); this.fencingEpoch = epoch;
      await c.query(`INSERT INTO forge_scheduler_workers(worker_id,fencing_epoch,heartbeat_at,lease_seconds,metadata) VALUES($1,$2,clock_timestamp(),$3,$4::jsonb) ON CONFLICT(worker_id) DO UPDATE SET fencing_epoch=EXCLUDED.fencing_epoch,heartbeat_at=EXCLUDED.heartbeat_at,lease_seconds=EXCLUDED.lease_seconds,metadata=EXCLUDED.metadata`, [this.schedulerId, epoch, this.leaseSeconds, JSON.stringify({ pid: process.pid, version: process.env.FORGE_RELEASE_ID || null })]);
      await c.query('COMMIT'); return epoch;
    } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); }
  }

  async create(input) {
    const tenantId = String(input.tenantId || ''); if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'TENANT_ISOLATION', statusCode: 400 });
    const triggerType = String(input.triggerType || 'CRON').toUpperCase(); const timezone = input.timezone || 'UTC';
    if (!['CRON', 'ONCE', 'DELAY', 'CALENDAR'].includes(triggerType)) throw new TypeError('invalid triggerType');
    if (!validTimeZone(timezone)) throw new TypeError(`invalid IANA timezone: ${timezone}`);
    if (triggerType === 'CRON' || triggerType === 'CALENDAR') parseCron(input.cronExpr);
    const id = input.id || randomUUID(); const version = Number(input.version || 1); const now = new Date(this.clock());
    const spec = { triggerType, cronExpr: input.cronExpr || null, fireAt: input.fireAt || null, timezone, dstGapPolicy: input.dstGapPolicy || 'SKIP', dstFoldPolicy: input.dstFoldPolicy || 'EARLIER' };
    const first = nextFire(spec, new Date(now.getTime() - 1));
    if (!first) throw Object.assign(new Error('schedule has no future occurrence'), { code: 'SCHEDULE_EXHAUSTED' });
    const client = await this.pool.connect();
    try { await client.query('BEGIN');
      await client.query(`INSERT INTO forge_schedules(id,tenant_id,project_id,version,trigger_type,cron_expr,fire_at,timezone,dst_gap_policy,dst_fold_policy,misfire_policy,catch_up_limit,max_misfire_age_seconds,next_fire_at,idempotency_prefix,handler_kind,payload,retry_policy,paused,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,false,$19)`, [id, tenantId, input.projectId || null, version, triggerType, spec.cronExpr, spec.fireAt, timezone, spec.dstGapPolicy, spec.dstFoldPolicy, input.misfirePolicy || 'COALESCE', Math.min(1000, Math.max(1, Number(input.catchUpLimit || 10))), Math.max(0, Number(input.maxMisfireAgeSeconds ?? 86400)), first.instant, input.idempotencyPrefix || `schedule:${id}`, input.handlerKind, JSON.stringify(input.payload || {}), JSON.stringify(input.retryPolicy || {}), input.createdBy || 'system']);
      await this.audit(client, { tenantId, projectId: input.projectId, scheduleId: id, actor: input.createdBy || 'system', action: 'CREATED', details: { nextFireAt: first.instant.toISOString(), version } });
      await client.query('COMMIT'); return this.get(id, tenantId, input.projectId);
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  }

  async get(id, tenantId, projectId = null) { const values = [id, tenantId]; let scope = ''; if (projectId) { values.push(projectId); scope = ` AND project_id=$${values.length}`; } const row = (await this.pool.query(`SELECT * FROM forge_schedules WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL${scope}`, values)).rows[0]; if (!row) throw Object.assign(new Error('schedule not found'), { code: 'NOT_FOUND', statusCode: 404 }); return row; }
  async list({ tenantId, projectId = null, limit = 100 } = {}) { const values = [tenantId, Math.min(200, Math.max(1, Number(limit)))]; let scope = ''; if (projectId) { values.push(projectId); scope = ` AND project_id=$${values.length}`; } return (await this.pool.query(`SELECT * FROM forge_schedules WHERE tenant_id=$1 AND deleted_at IS NULL${scope} ORDER BY next_fire_at NULLS LAST,id LIMIT $2`, values)).rows; }

  async audit(client, event) { await client.query(`INSERT INTO forge_schedule_audit(tenant_id,project_id,schedule_id,schedule_version,execution_epoch,actor,action,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [event.tenantId, event.projectId || null, event.scheduleId, event.scheduleVersion || null, event.executionEpoch || null, event.actor || 'system', event.action, event.requestId || null, JSON.stringify(event.details || {})]); }

  async setPaused({ id, tenantId, projectId = null, paused, actor = 'operator', requestId = null }) {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); const values = [id, tenantId, paused]; let scope = ''; if (projectId) { values.push(projectId); scope = ` AND project_id=$4`; }
      const row = (await client.query(`UPDATE forge_schedules SET paused=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL${scope} RETURNING *`, values)).rows[0]; if (!row) throw Object.assign(new Error('schedule not found'), { code: 'NOT_FOUND', statusCode: 404 });
      await this.audit(client, { tenantId, projectId: row.project_id, scheduleId: id, scheduleVersion: row.version, actor, requestId, action: paused ? 'PAUSED' : 'RESUMED' }); await client.query('COMMIT'); return row;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  }

  async preview({ id, tenantId, projectId = null, after = new Date() }) { const row = await this.get(id, tenantId, projectId); const spec = { triggerType: row.trigger_type, cronExpr: row.cron_expr, fireAt: row.fire_at, timezone: row.timezone, dstGapPolicy: row.dst_gap_policy, dstFoldPolicy: row.dst_fold_policy }; const next = nextFire(spec, new Date(after)); return next ? { scheduleId: id, nextFireAt: next.instant.toISOString(), localDate: next.localDate, timezone: row.timezone, ambiguous: !!next.ambiguous } : null; }

  async manualFire({ id, tenantId, projectId = null, actor = 'operator', requestId = null }) {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); const values = [id, tenantId]; let scope = ''; if (projectId) { values.push(projectId); scope = ` AND project_id=$${values.length}`; }
      const row = (await client.query(`SELECT * FROM forge_schedules WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL${scope} FOR UPDATE`, values)).rows[0]; if (!row) throw Object.assign(new Error('schedule not found'), { code: 'NOT_FOUND', statusCode: 404 });
      const epoch = Number(row.execution_epoch) + 1; const fireAt = new Date(); const key = `${row.id}:${row.version}:${epoch}:manual`; const occurrence = (await client.query(`INSERT INTO forge_schedule_occurrences(schedule_id,schedule_version,execution_epoch,fire_at,effective_fire_at,idempotency_key,metadata) VALUES($1,$2,$3,$4,$4,$5,$6::jsonb) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=clock_timestamp() RETURNING *`, [row.id, row.version, epoch, fireAt, key, JSON.stringify({ manual: true, actor })])).rows[0]; await client.query('UPDATE forge_schedules SET execution_epoch=$2,previous_fire_at=$3,updated_at=clock_timestamp() WHERE id=$1', [row.id, epoch, fireAt]); await this.audit(client, { tenantId, projectId: row.project_id, scheduleId: id, scheduleVersion: row.version, executionEpoch: epoch, actor, requestId, action: 'MANUAL_FIRE', details: { occurrenceId: occurrence.id } }); await client.query('COMMIT'); await this.triggerOccurrence(occurrence.id); return occurrence;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  }

  async recoverStaleLeases(limit = 100) { const r = await this.pool.query(`UPDATE forge_schedule_occurrences SET status='PENDING',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp(),error=jsonb_build_object('code','STALE_SCHEDULER_LEASE_RECOVERED') WHERE status='CLAIMED' AND lease_until<clock_timestamp() RETURNING id`); return r.rowCount; }

  async triggerOccurrence(id) {
    const client = await this.pool.connect(); let leaseToken;
    try { await client.query('BEGIN');
      const row = (await client.query(`SELECT o.*,s.tenant_id,s.project_id,s.handler_kind,s.payload,s.retry_policy,s.paused,s.deleted_at FROM forge_schedule_occurrences o JOIN forge_schedules s ON s.id=o.schedule_id WHERE o.id=$1 FOR UPDATE`, [id])).rows[0]; if (!row) throw new Error('occurrence not found'); if (row.status === 'TRIGGERED') { await client.query('COMMIT'); return row; }
      leaseToken = randomUUID(); const claimed = (await client.query(`UPDATE forge_schedule_occurrences SET status='CLAIMED',lease_owner=$2,lease_token=$3,lease_until=clock_timestamp()+($4::text||' seconds')::interval,claimed_at=clock_timestamp(),attempt=attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND status IN('PENDING','CLAIMED') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`, [id, this.schedulerId, leaseToken, this.leaseSeconds])).rows[0]; if (!claimed) { await client.query('COMMIT'); return null; }
      const jobId = randomUUID(); const key = claimed.idempotency_key; const job = (await client.query(`INSERT INTO forge_jobs(id,project_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_by) VALUES($1,$2,$3,$4::jsonb,100,$5,clock_timestamp(),$6,'durable-scheduler') ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=forge_jobs.updated_at RETURNING id`, [jobId, row.project_id, row.handler_kind, JSON.stringify({ ...(row.payload || {}), __scheduleOccurrenceId: id, __scheduleId: row.schedule_id, __scheduleEpoch: row.execution_epoch }), Number(row.retry_policy?.maxAttempts || 3), key])).rows[0];
      const done = (await client.query(`UPDATE forge_schedule_occurrences SET status='TRIGGERED',target_job_id=$2,triggered_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='CLAIMED' AND lease_owner=$3 AND lease_token=$4 RETURNING *`, [id, job.id, this.schedulerId, leaseToken])).rows[0];
      if (!done) throw Object.assign(new Error('scheduler occurrence fenced before trigger commit'), { code: 'STALE_SCHEDULER' });
      await client.query('COMMIT'); return done;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  }

  async tick({ limit = 50 } = {}) {
    if (this.fencingEpoch == null) await this.heartbeat();
    await this.recoverStaleLeases(limit);
    const client = await this.pool.connect(); let processed = 0; let triggered = 0; let skipped = 0; let misfires = 0;
    try {
      while (processed < limit) {
        await client.query('BEGIN');
        const row = (await client.query(`SELECT * FROM forge_schedules WHERE deleted_at IS NULL AND paused=false AND next_fire_at IS NOT NULL AND next_fire_at<=clock_timestamp() ORDER BY next_fire_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
        if (!row) { await client.query('COMMIT'); break; }
        const spec = { triggerType: row.trigger_type, cronExpr: row.cron_expr, fireAt: row.fire_at, timezone: row.timezone, dstGapPolicy: row.dst_gap_policy, dstFoldPolicy: row.dst_fold_policy };
        const now = new Date(); let due = []; let cursor = new Date(row.next_fire_at); const maxAge = Number(row.max_misfire_age_seconds) * 1000; const policy = row.misfire_policy;
        for (let i = 0; i < Number(row.catch_up_limit) && cursor <= now; i += 1) {
          const age = now.getTime() - cursor.getTime(); if (age > maxAge) { skipped += 1; misfires += 1; cursor = nextFire(spec, cursor)?.instant || null; if (!cursor) break; continue; }
          due.push(cursor); cursor = nextFire(spec, cursor)?.instant || null; if (!cursor) break;
        }
        if (policy === 'SKIP' && due.length) { skipped += due.length; due = []; }
        if (policy === 'COALESCE' && due.length > 1) { skipped += due.length - 1; due = [due[due.length - 1]]; }
        if (due.length) {
          for (const fireAt of due) {
            const epoch = Number(row.execution_epoch) + 1; const key = `${row.id}:${row.version}:${epoch}:${fireAt.toISOString()}`;
            await client.query(`INSERT INTO forge_schedule_occurrences(schedule_id,schedule_version,execution_epoch,fire_at,effective_fire_at,idempotency_key,metadata) VALUES($1,$2,$3,$4,$4,$5,$6::jsonb) ON CONFLICT(idempotency_key) DO NOTHING`, [row.id, row.version, epoch, fireAt, key, JSON.stringify({ misfire: fireAt < now, schedulerId: this.schedulerId })]);
            await client.query('UPDATE forge_schedules SET execution_epoch=$2,previous_fire_at=$3,updated_at=clock_timestamp() WHERE id=$1', [row.id, epoch, fireAt]); row.execution_epoch = epoch; triggered += 1;
          }
        }
        const next = cursor && cursor > now ? cursor : (cursor ? nextFire(spec, now)?.instant : null);
        await client.query(`UPDATE forge_schedules SET next_fire_at=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.id, next]);
        await this.audit(client, { tenantId: row.tenant_id, projectId: row.project_id, scheduleId: row.id, scheduleVersion: row.version, actor: this.schedulerId, action: due.length ? 'DUE' : 'MISFIRE_SKIPPED', details: { due: due.length, misfires, skipped } });
        await client.query('COMMIT'); processed += 1;
      }
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
    const pending = await this.pool.query(`SELECT id FROM forge_schedule_occurrences WHERE status='PENDING' AND effective_fire_at<=clock_timestamp() ORDER BY effective_fire_at,id LIMIT $1`, [limit]);
    for (const r of pending.rows) { try { const result = await this.triggerOccurrence(r.id); if (result) triggered += 1; } catch (error) { this.logger.error?.(JSON.stringify({ event: 'durable_scheduler.trigger_failed', occurrenceId: r.id, code: error.code, message: error.message })); } }
    return { processed, occurrences: triggered, skipped, misfires };
  }

  async health() { const r = await this.pool.query(`SELECT count(*) FILTER(WHERE paused=false AND deleted_at IS NULL)::int active,count(*) FILTER(WHERE paused=true AND deleted_at IS NULL)::int paused,count(*) FILTER(WHERE next_fire_at<=clock_timestamp() AND paused=false AND deleted_at IS NULL)::int overdue FROM forge_schedules`); const o = await this.pool.query(`SELECT count(*) FILTER(WHERE status='PENDING')::int pending,count(*) FILTER(WHERE status='CLAIMED')::int claimed,count(*) FILTER(WHERE status='TRIGGERED')::int triggered,count(*) FILTER(WHERE status='CLAIMED' AND lease_until<clock_timestamp())::int stale FROM forge_schedule_occurrences`); return { schedulerId: this.schedulerId, fencingEpoch: this.fencingEpoch, ...r.rows[0], ...o.rows[0] }; }
  async misfires({ tenantId, projectId = null, limit = 100 } = {}) { const values = [tenantId, Math.min(200, Math.max(1, Number(limit)))]; let scope = ''; if (projectId) { values.push(projectId); scope = ` AND s.project_id=$${values.length}`; } return (await this.pool.query(`SELECT o.*,s.handler_kind,s.timezone,s.misfire_policy FROM forge_schedule_occurrences o JOIN forge_schedules s ON s.id=o.schedule_id WHERE s.tenant_id=$1${scope} AND o.fire_at<clock_timestamp() AND o.status IN('PENDING','FAILED','SKIPPED') ORDER BY o.fire_at DESC LIMIT $2`, values)).rows; }
}

module.exports = { DurableScheduler, parseCron, nextCronOccurrence, nextFire, resolveLocalDateTime, validTimeZone };
