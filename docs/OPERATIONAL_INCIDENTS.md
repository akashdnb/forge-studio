# Operational Incident Detection, Alerting and Notification

Forge's incident subsystem continuously evaluates durable PostgreSQL state and turns actionable production conditions into durable incidents. Detection is rule-driven, deduplicated by deterministic fingerprints, rate-limited by aggregation groups, and delivered through the existing durable event/outbox/lease delivery path.

## Detection rules

Built-in rules are created per tenant on first detector pass:

- `stuck_job` — running job has not progressed beyond the configured threshold.
- `lease_expired` — running job lease is expired.
- `retry_exhausted` — failed job reached `max_attempts`.
- `dependency_blocked` — queued job remains blocked by a failed/cancelled dependency.
- `provider_degraded` — a provider has at least five recent runs with >=50% failures.
- `artifact_corrupt` — artifact lifecycle is `CORRUPT`, `MISSING`, or `QUARANTINED`.
- `budget_exhausted` — a configured usage budget is exhausted.
- `runner_outage` — an active external Forge runner execution has no heartbeat for two minutes.
- `reconciliation_drift` — a recent reconciliation run failed or repaired drift.
- `release_health_failure` — a recent release/migration checkpoint failed or was blocked.

Rules are stored in `incident_rules` and can be tuned through `PATCH /v1/ops/incident-rules/:id`.

## Incident lifecycle

`OPEN -> ACKNOWLEDGED -> RESOLVED` is the normal path. `SUPPRESSED` is used while maintenance windows or bounded rate controls suppress notifications. `REOPEN` is explicit and auditable. Ownership is recorded on acknowledgement/assignment. Resolution requires a reason and can include structured resolution evidence.

Every incident has:

- deterministic SHA-256 `fingerprint` and `group_key`;
- tenant and optional project scope;
- severity and source identity;
- occurrence count and last-seen time;
- bounded evidence containing identifiers and safe operational state only;
- escalation level and next escalation time;
- immutable action history and audit mirror.

The active-fingerprint unique index prevents concurrent detector workers from creating duplicate active incidents. Lifecycle transitions lock the incident row before mutation.

## Notification delivery

Incident events are inserted transactionally into `forge_events` and `forge_outbox`. The existing durable event fanout creates delivery records with deterministic IDs. Delivery uses leases, retries/backoff, rate limits, concurrency limits, recovery of expired leases, and a DLQ. No incident notification is fire-and-forget.

Configured webhook channels can subscribe to these event types:

- `incident.created`
- `incident.acknowledge`
- `incident.assign`
- `incident.suppress`
- `incident.unsuppress`
- `incident.resolve`
- `incident.reopen`
- `incident.escalate`

Use the existing `/v1/event-subscriptions` API. The incident subscription bridge accepts the event types above while retaining the existing encrypted-secret, SSRF, tenant/project and delivery security controls.

Incident payloads intentionally contain no job payloads, provider credentials, webhook secrets, authorization headers, tokens, or raw provider errors.

## Maintenance and suppression

Create a bounded maintenance window:

```http
POST /v1/ops/maintenance-windows
Authorization: Bearer ...
Content-Type: application/json

{"projectId":"project-1","ruleKey":"provider_degraded","startsAt":"2026-10-27T20:00:00Z","endsAt":"2026-10-27T21:00:00Z","reason":"Planned provider maintenance"}
```

A window can be tenant-wide (`projectId` omitted) or rule-specific (`ruleKey` omitted for all rules). It never deletes evidence; observations remain durable and the incident records suppressed occurrences.

## Operator API

- `GET /v1/ops/incidents`
- `GET /v1/ops/incidents/:id`
- `POST /v1/ops/incidents/:id/acknowledge`
- `POST /v1/ops/incidents/:id/assign`
- `POST /v1/ops/incidents/:id/suppress`
- `POST /v1/ops/incidents/:id/unsuppress`
- `POST /v1/ops/incidents/:id/resolve`
- `POST /v1/ops/incidents/:id/reopen`
- `GET /v1/ops/incident-rules`
- `PATCH /v1/ops/incident-rules/:id`
- `GET /v1/ops/maintenance-windows`
- `POST /v1/ops/maintenance-windows`
- `DELETE /v1/ops/maintenance-windows/:id`
- `GET /v1/ops/incident-metrics`

All endpoints require the OWNER role. Incident actions require a reason of 8–1000 characters. Use an idempotency key for clients that may retry commands.

## Metrics and health

The operations metrics endpoint reports active incidents by severity, notification backlog/dead-letter counts, suppressed occurrences and escalation lag. Worker observability additionally exposes `forge_incident_detection_runs_total` and `forge_incident_detection_events_total`.

Alert on:

- rising active `CRITICAL`/`ERROR` incidents;
- notification `dead_letter > 0`;
- increasing pending/retry delivery backlog;
- increasing escalation lag;
- detector failures;
- runner/provider outage incidents.

## Runbook

### Stuck / expired job

Inspect the incident evidence and `/v1/ops/jobs/:id`. Prefer the Operations Control Plane's `recover` for an expired lease or `fence` when a stale worker must be prevented from completing. Do not edit `forge_jobs` directly.

### Retry exhaustion

Inspect provider, dependency, budget and artifact evidence before retrying. Never increase retry budgets as an incident response shortcut. Publishing and other externally visible side-effect jobs are protected by the Operations Control Plane.

### Provider degradation

Disable the provider through the Operations Control Plane before broad retries. Existing provider-run database guards reject new provider runs while the provider is disabled. Use reconciliation after recovery.

### Artifact corruption

Quarantine the immutable artifact. Reconciliation/storage tooling owns repair and provenance verification. Never replace content-addressed bytes in place.

### Budget exhaustion

Treat exhaustion as admission control. Fix or explicitly change the budget configuration through its normal governance path; never mutate usage reservations to bypass the gate.

### Runner outage

Inspect active `forge_execution_runs` and runner heartbeat state. Fence/recover only through the control plane. Validate callback/reconciliation state before replaying external work.

### Reconciliation drift

Inspect the reconciliation run and repair records. A successful reconciliation with repairs is an incident signal, not a reason to overwrite immutable provenance.

### Release / migration health

Stop rollout on failed/blocked checkpoints. Use release-safety preflight, schema-drift evidence and the existing migration runner. Do not use the incident API to execute migrations.

## Configuration

- `FORGE_INCIDENT_DETECTION_INTERVAL_MS` — detector interval, default 60000 ms, bounded to >=30000.
- `FORGE_OPS_PG_POOL_MAX` — operations API pool size.
- Existing durable event delivery settings continue to control webhook retries, leases, timeout and concurrency.

Migration `022_operational_incidents.sql` must be applied before enabling the worker detector in production.
