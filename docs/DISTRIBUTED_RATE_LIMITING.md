# Distributed API Rate Limiting, Burst Protection and Tenant Fairness

Forge enforces a second, durable HTTP admission boundary in PostgreSQL. PostgreSQL is the source of truth and the atomic coordination point across API instances; no process-local counter is authoritative.

## Policy model

Policies are scoped `GLOBAL`, `TENANT`, or `PROJECT` and bind a `plan_version`, canonical `route_class`, HTTP `method`, sustained rate, burst capacity, concurrency limit, priority, enforcement mode, failure mode and monotonically increasing `effective_version`.

Route aliases such as `/v1/episodes/:id` and `/v2/episodes/:id` canonicalize to the same bounded route class. Resource identifiers are never used as policy keys.

The migration seeds a conservative global `120 req/min`, burst `60`, concurrency `32` policy. Tenant/project policies override it and are evaluated hierarchically, so a noisy tenant cannot consume another tenant's bucket. Existing durable worker fairness remains authoritative for background jobs; HTTP admission adds independent per-tenant/project buckets and a global guard.

## Atomic enforcement

Each request obtains a PostgreSQL transaction and transaction-scoped advisory lock for every applicable bucket. Refill uses PostgreSQL `clock_timestamp()` and clamps elapsed time, so process clock skew cannot mint tokens. Bucket state and the request admission record commit together.

`X-Idempotency-Key` or `X-Request-Id` is the request identity. A repeated key reuses the original admission decision instead of consuming another token. Concurrency is released on response `finish`/`close`; crash recovery is naturally bounded by the request record and can be reconciled from bucket/request state.

## Failure semantics

- `FAIL_CLOSED`: a distributed-store error returns `503 RATE_LIMIT_UNAVAILABLE`.
- `FAIL_OPEN`: the request is admitted and emits `x-forge-rate-limit-degraded: fail-open`.
- `SHADOW`: policy decisions are recorded but do not consume enforcement tokens.
- `DISABLED`: policy is ignored.

`429` responses include `Retry-After` in seconds. Operator endpoints remain owner-protected and tenant-scoped.

## Trusted internal bypass

A bypass is never inferred from a URL or user role. It requires both `FORGE_RATE_LIMIT_INTERNAL_TOKEN` and the request headers `X-Forge-Internal-Token` and `X-Forge-Internal-Scope`. A policy must explicitly name the same `trusted_bypass_scope`. Keep the token outside application logs and rotate it as an incident credential.

## Operator API

All endpoints are under `/internal/rate-limits/` and require an `OWNER` identity:

- `GET /health` — PostgreSQL latency/health.
- `GET /policies?projectId=` — active effective policy state.
- `PUT /policies` — create a new immutable policy version.
- `GET /usage?projectId=` — one-hour route/outcome counters.
- `POST /reset` — reset bucket tokens/concurrency for a tenant/project/route.
- `POST /emergency` — install an expiring fail-closed throttle.
- `GET /metrics` — in-process diagnostic counters; PostgreSQL request/audit tables are the durable evidence.

Every policy update/reset is durable audit evidence. Emergency throttles are represented as expiring policy rows and do not overwrite the normal policy version.

## Incident response

### Sudden 429 increase

1. Check `/internal/rate-limits/metrics` and `/internal/rate-limits/usage`.
2. Inspect the active tenant/project policy version.
3. Check for a recent emergency throttle or plan-version rollout.
4. Do not manually edit bucket rows. Use `/reset` only after identifying the cause.
5. If the database is degraded, inspect the policy `fail_mode` before changing traffic routing.

### Emergency overload protection

Throttle a tenant with a short-lived fail-closed policy. Prefer the smallest scope that contains the incident. Record the incident/change reference in `reason` and remove/expire the throttle after the incident.

### Stale state after failover

PostgreSQL time and row/advisory locking make another API instance safe to take over immediately. If a worker/process died while holding concurrency, inspect `forge_rate_limit_requests.released_at` and bucket `active_concurrency`; reconcile only through a controlled operator action, never by deleting request evidence.

### Policy rollout

Create a new policy version rather than editing an active row. The previous row remains immutable evidence. Verify `effective_version`, `plan_version`, and the route class before moving traffic.

## Verification

Run the migration, syntax checks, integration suite and full repository check. The PostgreSQL suite covers multi-instance burst races, retry idempotency, tenant/project isolation, policy versioning, clock rollback, failure injection and load-oriented concurrent admission.
