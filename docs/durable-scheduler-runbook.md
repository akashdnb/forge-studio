# Durable Scheduler runbook

The durable scheduler is PostgreSQL-backed. Scheduler ticks are coordination only; schedule identity, fire times, occurrences, leases, fencing, retry/delay state, and audit evidence live in PostgreSQL.

## Health

`GET /internal/scheduler/health` (operator/admin role) reports active/paused/overdue schedules and pending/claimed/triggered/stale occurrences.

## Operator actions

- `GET /v1/schedules?projectId=...` — inspect tenant/project schedules.
- `GET /v1/schedules/:id` — inspect schedule state and next fire.
- `POST /v1/schedules/:id/pause` — pause without deleting state.
- `POST /v1/schedules/:id/resume` — resume the same schedule identity.
- `POST /v1/schedules/:id/fire` — create an audited manual occurrence.
- `POST /v1/schedules/:id/preview` — calculate the next occurrence using the persisted IANA timezone and DST policy.
- `POST /v1/schedules/:id/misfires` — inspect overdue pending/failed/skipped occurrences.
- `POST /v1/schedules/:id/recover-lease` — recover expired occurrence leases.

## Recovery rules

1. Do not delete `forge_schedule_occurrences` to clear a stuck trigger. Recover its expired lease so the idempotency key remains durable.
2. If a scheduler process disappears, another process advances the fencing epoch and can reclaim expired occurrence leases.
3. If a database failover occurs, PostgreSQL remains the source of truth. A retried tick is safe because occurrence identity is unique on schedule/version/epoch/fire time and idempotency key.
4. Long outages are bounded by each schedule's `catch_up_limit` and `max_misfire_age_seconds`. `SKIP` drops missed occurrences, `COALESCE` emits only the latest eligible occurrence, and `CATCH_UP` emits at most the configured bound.
5. DST gaps are either skipped or shifted forward according to `dst_gap_policy`; folds are deterministic through `EARLIER`, `LATER`, or `BOTH`.
6. Tenant and project scope is checked before schedule creation/listing/operator actions. Jobs released by a schedule keep the original project scope.

## Retry/delay integration

Future `JobQueue.enqueue({ availableAt })` and retry delays from `JobQueue.fail()` are registered as durable `DELAY` schedules. When the occurrence fires, the scheduler atomically advances the existing queued job rather than creating a duplicate job. The existing job idempotency key remains the execution deduplication boundary.

## Diagnostics

Useful queries:

```sql
SELECT id, tenant_id, project_id, paused, next_fire_at, misfire_policy
FROM forge_schedules
WHERE deleted_at IS NULL
ORDER BY next_fire_at NULLS LAST;

SELECT schedule_id, status, fire_at, lease_owner, lease_until, idempotency_key
FROM forge_schedule_occurrences
WHERE status IN ('PENDING','CLAIMED')
ORDER BY fire_at;

SELECT *
FROM forge_schedule_audit
ORDER BY created_at DESC
LIMIT 100;
```

Alert on overdue active schedules, stale claimed occurrences, repeated trigger failures, and scheduler heartbeat/fencing errors. Never use an in-memory timer as the source of truth for a production trigger.
