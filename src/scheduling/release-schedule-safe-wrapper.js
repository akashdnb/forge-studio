'use strict';

const { createReleaseScheduleService: createBaseService } = require('./release-scheduler');

function formatter(timeZone) { return new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
function localParts(date, timeZone) { const p = {}; for (const x of formatter(timeZone).formatToParts(date)) if (x.type !== 'literal') p[x.type] = Number(x.value); return p; }
function validTimeZone(zone) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; } }
function parseTime(v) { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v); if (!m) throw new TypeError('localTime must be HH:mm'); return { hour: Number(m[1]), minute: Number(m[2]) }; }
function resolveLocal(dateString, timeString, zone) {
  const [y, m, d] = dateString.split('-').map(Number); const { hour, minute } = parseTime(timeString); const naive = Date.UTC(y, m - 1, d, hour, minute); const exact = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 1) { const c = new Date(naive - offset * 60000); const p = localParts(c, zone); if (p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute) exact.push(c); }
  if (exact.length) return { instant: new Date(Math.min(...exact.map((x) => x.getTime()))), ambiguous: exact.length > 1, dstAdjusted: false };
  let best = null;
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 1) { const c = new Date(naive - offset * 60000); const p = localParts(c, zone); if (p.year !== y || p.month !== m || p.day !== d) continue; const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); if (wall >= naive && (!best || wall < best.wall || (wall === best.wall && c < best.instant))) best = { instant: c, wall }; }
  if (best) return { instant: best.instant, ambiguous: false, dstAdjusted: true };
  throw Object.assign(new Error(`Unable to resolve local time ${dateString} ${timeString} in ${zone}`), { code: 'TIMEZONE_RESOLUTION_FAILED' });
}
function addDays(dateString, days) { const [y, m, d] = dateString.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); }
function nextOccurrence(spec, after = new Date()) {
  if (!validTimeZone(spec.timezone)) throw new TypeError(`Invalid IANA timezone: ${spec.timezone}`);
  if (spec.scheduleKind === 'ONCE') { const r = resolveLocal(spec.localDate, spec.localTime, spec.timezone); return r.instant > after ? { ...r, localDate: spec.localDate } : null; }
  const p = localParts(after, spec.timezone); const start = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; const days = spec.scheduleKind === 'WEEKLY' ? new Set((spec.weekdays || []).map(Number)) : null;
  for (let i = 0; i <= 370; i += 1) { const localDate = addDays(start, i); const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay(); if (days && !days.has(weekday)) continue; const r = resolveLocal(localDate, spec.localTime, spec.timezone); if (r.instant > after) return { ...r, localDate }; }
  throw Object.assign(new Error('schedule has no future occurrence'), { code: 'SCHEDULE_EXHAUSTED' });
}
function rejectDstGapSchedule(spec) { const first = nextOccurrence(spec, new Date(Date.now() - 1)); if (first?.dstAdjusted) throw Object.assign(new Error('scheduled local time falls inside a DST gap; choose a representable wall-clock time'), { code: 'DST_NONEXISTENT_LOCAL_TIME', statusCode: 422 }); if (spec.scheduleKind === 'ONCE') return; const start = first?.localDate || localParts(new Date(), spec.timezone); for (let i = 0; i <= 370; i += 1) { const localDate = typeof start === 'string' ? addDays(start, i) : addDays(`${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`, i); const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay(); if (spec.scheduleKind === 'WEEKLY' && !(spec.weekdays || []).includes(weekday)) continue; const resolved = resolveLocal(localDate, spec.localTime, spec.timezone); if (resolved.dstAdjusted) throw Object.assign(new Error(`schedule crosses a DST gap on ${localDate}`), { code: 'DST_NONEXISTENT_LOCAL_TIME', statusCode: 422 }); } }

function createSafeReleaseScheduleService(options = {}) {
  const base = createBaseService(options);
  async function repair(schedule) { if (!schedule?.version) return; const v = schedule.version; const after = schedule.last_run_at ? new Date(schedule.last_run_at) : new Date(Date.now() - 1); const next = nextOccurrence({ scheduleKind: v.schedule_kind, timezone: v.timezone, localDate: v.local_date, localTime: String(v.local_time).slice(0, 5), weekdays: v.weekdays || [] }, after); if (next?.instant) await options.pool.query('UPDATE forge_release_schedules SET next_run_at=$2,updated_at=now() WHERE id=$1 AND current_version=$3', [schedule.id, next.instant, schedule.current_version]); }
  return {
    ...base,
    async create(args) { rejectDstGapSchedule({ scheduleKind: String(args.scheduleKind || 'ONCE').toUpperCase(), timezone: args.timezone || 'UTC', localDate: args.localDate, localTime: args.localTime, weekdays: args.weekdays || [] }); const result = await base.create(args); await repair(result); return base.get(result.id, args.tenantId, args.projectId); },
    async mutate(id, args) { const current = await base.get(id, args.tenantId, args.projectId); const patch = args.patch || {}; rejectDstGapSchedule({ scheduleKind: String(patch.scheduleKind || current.version.schedule_kind).toUpperCase(), timezone: patch.timezone || current.version.timezone, localDate: patch.localDate ?? current.version.local_date, localTime: patch.localTime || String(current.version.local_time).slice(0, 5), weekdays: patch.weekdays ?? current.version.weekdays ?? [] }); const result = await base.mutate(id, args); await repair(result); return base.get(result.id, args.tenantId, args.projectId); },
    async tick(args) { const result = await base.tick(args); const rows = (await options.pool.query(`SELECT s.id,s.current_version,s.last_run_at,s.next_run_at,v.schedule_kind,v.timezone,v.local_date,v.local_time,v.weekdays FROM forge_release_schedules s JOIN forge_release_schedule_versions v ON v.schedule_id=s.id AND v.version=s.current_version WHERE s.status='ACTIVE' LIMIT $1`, [args?.limit || 25])).rows; for (const row of rows) { const next = nextOccurrence({ scheduleKind: row.schedule_kind, timezone: row.timezone, localDate: row.local_date, localTime: String(row.local_time).slice(0, 5), weekdays: row.weekdays || [] }, row.last_run_at ? new Date(row.last_run_at) : new Date(Date.now() - 1)); if (next?.instant && new Date(row.next_run_at).getTime() !== next.instant.getTime()) await options.pool.query('UPDATE forge_release_schedules SET next_run_at=$2,updated_at=now() WHERE id=$1 AND current_version=$3', [row.id, next.instant, row.current_version]); } return result; },
    nextOccurrence,
    resolveLocalDateTime: resolveLocal,
  };
}

const releaseSchedulerModule = require('./release-scheduler');
releaseSchedulerModule.createReleaseScheduleService = createSafeReleaseScheduleService;
module.exports = { createSafeReleaseScheduleService, nextOccurrence, resolveLocalDateTime: resolveLocal };
