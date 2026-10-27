# Tenant Resource Quotas and Fairness

Forge applies one durable PostgreSQL admission boundary to every durable background job. Workflow, generation, transcription, media, artifact processing, publishing, reconciliation, scheduled work and retries pass through `JobQueue.claim`/`claimSpecific`; provider and runner work is therefore bounded by the reservation held by the owning job.

## Policy model
`forge_resource_policies` has tenant and project scopes. Project limits are hierarchical with tenant limits: both must admit a reservation. Policies contain CPU reservation budget, concurrency, job-count limit, queue weight, priority class, bounded burst, aging and a maximum reservation lifetime. Every change creates a new `effective_version`; reservations record policy and plan versions.

Weighted fair queueing uses a virtual-finish value. Priority is evaluated first, while aging continuously reduces the effective priority of waiting work so low-priority tenants cannot starve indefinitely. Created time and job id are deterministic tie breakers.

## Crash/retry safety
Reservations are unique for `(job_id, attempt)`. Concurrent workers serialize on a tenant advisory lock. Retry/cancel releases the current attempt; success commits it and records actual CPU when supplied. Lease recovery expires stale reservations, preventing crashes from permanently consuming capacity.

## Plan changes
Policies are versioned. New claims use the new effective version; existing reservations keep their policy/plan snapshot. Increasing limits affects subsequent admissions; decreasing limits never retroactively kills an admitted execution.

## Operator API
- `GET /internal/resource-fairness/diagnostics?tenantId=&projectId=` — queue depth, fairness state and held/expired reservations.
- `GET /internal/resource-fairness/reservations?tenantId=&projectId=` — reservation inspection.
- `POST /internal/resource-fairness/policies` — create a new effective policy version.
- `POST /internal/resource-fairness/recover` — recover expired reservations.

Endpoints require an authenticated OWNER in the same tenant; cross-tenant project identifiers are rejected.

## Incident response
Inspect diagnostics for queue depth, virtual-finish skew, held reservations, expired reservations and the active policy version. Check throttles and recent quota changes. Run stale reservation recovery rather than deleting rows. Inspect priority/weight/aging and dependency chains before raising priority. Use emergency throttles only for containment and restore a normal versioned policy after mitigation.

## Verification
Run `npm run check` and `npm test`. With PostgreSQL configured, `test/tenant-resource-fairness.postgres.test.js` exercises concurrent reservation idempotency and tenant/project isolation against the real database.
