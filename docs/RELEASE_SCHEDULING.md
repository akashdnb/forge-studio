# Durable Release Scheduling & Publishing Calendar

Forge Studio release schedules are durable PostgreSQL records, not UI timers. A schedule version is immutable and contains the IANA timezone, recurrence, destination set, destination windows, blackout policy, missed-window policy and a canonical SHA-256 snapshot.

## Execution path

1. API creates or versions a tenant/project/episode schedule.
2. The worker's existing `WorkflowScheduler` heartbeat invokes the release-calendar tick using `FOR UPDATE SKIP LOCKED`.
3. A due occurrence is evaluated against tenant/project emergency hold, release epoch, approval, QA, selected render, storage checksum, canonical package, optional package attestation metadata, active destination credential and provider capacity.
4. A gate snapshot and deterministic execution fingerprint are persisted before a `publish_runs` record is created.
5. The publish run and release execution use deterministic idempotency keys. A durable `publish:scheduled` job is inserted through the normal `JobQueue`, so tenant quota/capacity governance remains authoritative.
6. The worker fences scheduled execution again immediately before publishing. A paused/cancelled schedule, stale schedule version, changed release epoch, changed gate fingerprint or failed current gate cannot publish.
7. The existing destination publisher performs the real upload, persists publish receipts and provider reconciliation state, and remains responsible for provider-level idempotency.
8. Reconciliation recreates a missing scheduled job after a crash between execution creation and job enqueue, and converges execution state from durable publish receipts/jobs.

There is no calendar-only success path: a schedule only creates a real publish job and that job enters the existing durable publishing pipeline.

## API

- `GET /v1/release-schedules?projectId=...`
- `POST /v1/release-schedules`
- `GET /v1/release-schedules/:id`
- `PATCH /v1/release-schedules/:id` — creates an immutable schedule version.
- `POST /v1/release-schedules/:id/pause`
- `POST /v1/release-schedules/:id/resume`
- `POST /v1/release-schedules/:id/cancel`
- `GET /v1/release-schedules/:id/executions`
- `POST /v1/release-calendar/blackouts`
- `GET /v1/release-calendar/controls?projectId=...`
- `PUT /v1/release-calendar/controls` — owner-only emergency hold / release-epoch bump.
- `GET /internal/release-calendar/metrics` — tenant-scoped operational metrics.

Example schedule:

```json
{
  "projectId": "project-123",
  "episodeId": "episode-456",
  "scheduleKind": "WEEKLY",
  "timezone": "America/New_York",
  "localTime": "09:00",
  "weekdays": [1, 3, 5],
  "destinations": ["youtube"],
  "destinationWindows": {
    "youtube": { "timezone": "America/Los_Angeles", "start": "06:00", "end": "22:00" }
  },
  "blackoutPolicy": "DEFER",
  "missedWindowPolicy": "NEXT_WINDOW",
  "maxMissedWindowAgeSeconds": 86400,
  "priority": 50
}
```

## Timezones and DST

Only IANA timezone identifiers are accepted. Wall-clock schedule values are resolved with `Intl.DateTimeFormat` rather than server-local time. During a spring-forward gap, the scheduler advances to the first representable wall-clock minute. During fall-back ambiguity, the earliest matching instant is selected and the ambiguity is recorded by the deterministic resolution logic.

Changing timezone, recurrence, local time, destinations or windows creates a new immutable version. Existing queued executions retain their original version and are fenced if the schedule's current version has changed.

## Blackouts, holds and epochs

Blackouts may be tenant-wide or project/destination-specific. `DEFER` records the occurrence as blocked; `SKIP` records an explicit skipped occurrence. Emergency hold is project-scoped and is checked both during scheduling and at execution. Bumping the project release epoch invalidates queued schedule executions created under the previous epoch. Operators must use the control endpoint rather than editing rows directly so an audit event is preserved.

## Gate and credential semantics

The scheduling gate is deliberately conservative. It requires:

- approved/current render and matching render version;
- trusted SHA-256 artifact and ready storage;
- latest passing/warnings QA result;
- matching final-render approval;
- latest ready episode package matching the render version;
- if package metadata declares an attestation, it must be `VERIFIED`;
- an active, unexpired destination credential scoped to the tenant/project;
- provider capacity not draining, shedding or hard-blocked;
- no emergency hold.

The same gate is re-evaluated immediately before publication. A changed gate fingerprint never silently republishes a different artifact.

## Failure recovery

A scheduler crash is safe because schedule rows, immutable versions, execution rows and publish runs are persisted. A crash after creating the execution but before creating the job is repaired by scheduler reconciliation using the deterministic job idempotency key. A provider outage is handled by the existing publish retry/reconciliation state machine. An uncertain provider result is never blindly retried if the publishing adapter marks the run as reconciliation-required.

Clock skew is intentionally bounded by using PostgreSQL `now()` for due selection and persisted `planned_at`/`gate_snapshot` timestamps. Worker-local time is only used for diagnostic timestamps and deterministic test clocks.

## Configuration

- `FORGE_RELEASE_SCHEDULER_TICK_LIMIT` — due schedules processed per worker heartbeat; default `25`.
- `FORGE_RELEASE_SCHEDULER_RECONCILE_LIMIT` — executions reconciled per heartbeat; default `100`.
- `FORGE_RELEASE_API_POOL_MAX` — dedicated release API pool size; default `4`.

The release scheduler uses the existing worker scheduler, queue, quota/capacity admission and publishing credentials. No release-specific bypass switches exist.

## Diagnostics / metrics

`/internal/release-calendar/metrics` reports active/paused/cancelled/overdue schedules and execution counts by state. Inspect `forge_release_schedule_audit`, `forge_release_schedule_executions`, `publish_runs`, `publish_receipts`, `forge_jobs`, `forge_capacity_pools` and credential state together when diagnosing a release.

Recommended alerts:

- overdue active schedules increasing;
- executions stuck in `BLOCKED` or `RECONCILIATION_REQUIRED`;
- release job enqueue failures;
- repeated `STALE_RELEASE_EPOCH` / `STALE_SCHEDULE_VERSION` events;
- provider capacity in `DRAINING`, `SHED` or `HARD`;
- destination credential unavailable/expired;
- publish receipts missing while publish jobs are terminal.

## Operator runbook

1. **Pause a project schedule** before changing production conditions.
2. **Enable emergency hold** for a project when all scheduled publishing must stop.
3. **Rotate credentials** through the provider credential registry; queued schedules re-evaluate credentials at execution time.
4. **Bump the release epoch** after a release-control incident to fence all previously queued scheduled executions.
5. **Inspect the execution snapshot** before manually retrying. Do not edit an immutable schedule version or execution row in SQL.
6. **Reconcile provider state** when a publish run is uncertain; never create a second publish run manually for the same schedule occurrence/destination.
7. Resume only after approval/QA/package/credential/capacity conditions are healthy.
