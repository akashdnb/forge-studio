# Distributed coordination runbook

## Scope

`forge_coordination_locks` is the durable PostgreSQL coordination primitive for cross-process critical sections. Ownership is decided by PostgreSQL `clock_timestamp()`, not process clocks. Every ownership change increments both `fencing_token` and `epoch`; renewals keep both unchanged.

Existing job leases, scheduler `FOR UPDATE SKIP LOCKED` claims, capacity claims, credential leases, publish leases, and scheduler fenced runtime remain authoritative for their existing state machines. The new subsystem is used as a fencing layer only where a stale process can otherwise finalize a durable side effect. The first integrated path is publish finalization.

## Safety invariants

1. A writer must hold `state='HELD'`, matching `scope_key`, `owner_id`, `fencing_token`, and `epoch`.
2. Expiry is evaluated with PostgreSQL time. Application clock skew cannot extend ownership.
3. A superseded owner cannot renew or release a newer epoch.
4. Release is idempotent; a stale release returns `SUPERSEDED` without changing the current owner.
5. A dead process does not strand capacity: an expired row is recovered atomically by the next acquisition.
6. Publishing finalization checks the fence inside the same PostgreSQL transaction that marks the publish run and episode complete.
7. Tenant/project scope is carried in every coordination record and should be part of the scope key for tenant-owned resources.

## Operator API

Run `node scripts/coordination-operator-http.js` with `DATABASE_URL` and `FORGE_COORDINATION_OPERATOR_TOKEN`.

- `GET /health` — lock table health.
- `GET /locks?tenantId=&projectId=&scopeKey=&includeReleased=true` — inspect ownership and expiry.
- `POST /locks/recover` with `{ "scopeKey": "...", "reason": "..." }` — recover an already-expired lock only.
- `GET /metrics` — one-hour ownership transition counts plus current held/expired counts.

Recovery is intentionally refusal-oriented: an unexpired lock cannot be force-recovered through this endpoint.

## Incident handling

### Coordination fence lost

Treat `COORDINATION_FENCE_LOST` / `PUBLISH_COORDINATION_FENCE_LOST` as stale work. Do not retry the stale transaction blindly. Reconcile the resource using its durable state and the latest fencing token, then enqueue a fresh attempt if appropriate.

### Acquisition storm

Use bounded waits (`waitMs`) and inspect the lock's priority, owner, expiry and audit history. Do not introduce process-local mutexes or advisory locks around the same resource.

### Database failover / transaction retry

Acquisition treats PostgreSQL deadlock, serialization, lock-timeout and unique-race errors as retryable while the caller's bounded wait remains. A lost DB connection is never treated as a successful acquisition or renewal.

### Process pause / clock skew

A paused process may wake after its lease expires. Its next durable write must re-check the fencing tuple in PostgreSQL. Never compare local wall-clock expiry and assume ownership survived.

## Migration / replay

Migration `161_distributed_coordination.sql` is ledger-safe through the existing migration runner. It is additive and replay-safe. Export/import and replay tooling must preserve the coordination tables only as audit evidence; active ownership must never be restored as live ownership after a failover. Any imported lock row should be considered expired/released before a new owner acquires it.

## Review checklist for future integrations

- Is there already a durable lease/claim state machine? Reuse it instead of adding a second lease.
- If this subsystem is added, is the final side-effect transaction fenced using the current token/epoch?
- Does the scope include tenant/project identity where the resource is tenant-owned?
- Are acquisition waits bounded and deterministic?
- Does a crash release capacity through expiry rather than a process callback?
- Are stale writers rejected after a pause, retry, duplicate worker, or region failover?
- Are operator recovery actions auditable and refusal-oriented?
