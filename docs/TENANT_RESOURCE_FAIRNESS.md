# Tenant Resource Quotas and Fairness

Forge applies one durable PostgreSQL admission boundary to every durable background job. Workflow, generation, transcription, media, artifact processing, publishing, reconciliation, scheduled work and retries all pass through `JobQueue.claim`/`claimSpecific`; provider and runner work is therefore bounded by the reservation held by the owning job.

## Policy model

`forge_resource_policies` has tenant and project scopes. Project limits are hierarchical with tenant limits: both must admit a reservation. A policy contains CPU reservation budget, concurrency, job-count limit, queue weight, priority class, bounded burst, aging and a maximum reservation lifetime. Each change creates a new `effective_version`; the admitted reservation records the exact tenant/project policy versions and plan version.

`queue_weight` implements weighted fair queueing using a virtual-finish value. `priority_class` is evaluated first, but aging continuously reduces the effective priority of waiting work so a low-priority tenant cannot starve indefinitely. `created_at` and job id are final deterministic tie breakers.

## Crash and retry safety

A reservation is unique for `(job_id, attempt)`. Concurrent workers serialize on a tenant advisory lock. A retry releases the previous attempt before the next claim can reserve capacity. Success commits the reservation and records actual CPU when supplied by the handler. Cancellation releases it. Worker/lease recovery expires stale reservations, so a crashed process cannot permanently consume capacity.

The job lease remains the execution fence. A worker that loses its lease cannot settle the reservation through the normal terminal path.

## Plan changes

Policies are immutable by version from the operator's perspective. A new policy is activated by deactivating the old row and creating a new `effective_version`. Existing reservations keep their plan/policy snapshot; new claims use the new limits. Increasing a limit therefore takes effect on subsequent admissions. Decreasing a limit never retroactively invalidates an already admitted execution; it only blocks new reservations until active usage falls below the new bound.

## Operator API

All endpoints require an authenticated `OWNER` in the same tenant:

- `GET /internal/resource-fairness/diagnostics?tenantId=&projectId=` — queue depth, fairness state and held/expired reservations.
- `GET /internal/resource-fairness/reservations?tenantId=&projectId=` — reservation inspection.
- `POST /internal/resource-fairness/policies` — create a new effective policy version.
- `POST /internal/resource-fairness/recover` — recover expired reservations.

Cross-tenant tenant/project identifiers are rejected before diagnostics or mutation.

## Incident response

1. Inspect diagnostics for queue depth, virtual-finish skew, held reservations and expiration counts.
2. Check whether a tenant/project has an emergency throttle or a recently reduced limit.
3. Run stale reservation recovery; do not delete reservation rows manually.
4. If a tenant is starving, inspect its `priority_class`, `queue_weight`, `aging_seconds` and dependency chain before raising priority.
5. Use an emergency throttle for containment, then create a normal versioned policy after the incident.

## Metrics

The worker emits `forge_resource_release_failures_total` and `forge_resource_stale_recovery_failures_total`. Durable audit rows in `forge_resource_audit` are the authoritative admission/release evidence; `forge_resource_reservations`, `forge_resource_fairness` and `forge_resource_usage_windows` provide operational state.

## Verification

Run `npm run check` and `npm test`. When PostgreSQL is available, `test/tenant-resource-fairness.postgres.test.js` exercises concurrent reservation idempotency and tenant/project isolation against the real database.
