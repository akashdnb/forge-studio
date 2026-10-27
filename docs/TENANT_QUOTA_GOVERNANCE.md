# Tenant Quotas, Rate Limiting, Fair-Use Admission and Resource Governance

Forge Studio enforces resource governance at the PostgreSQL durability boundary and in the production API/worker process. Policy, reservations, rate-limit buckets, fairness state and audit evidence survive process restarts and are shared by all API/worker instances.

## Scope

The effective policy is hierarchical. A project policy overrides the tenant policy for a field when the project field is non-null; otherwise the tenant field applies. Policies are versioned and every change stores an immutable snapshot in `forge_quota_policy_history` plus an operator audit record in `forge_quota_audit`.

Governed dimensions: `requests`, `concurrent_jobs`, `provider_executions`, `artifact_bytes`, `storage_operations`, `runner_executions`, `cpu_ms` and `wall_time_ms`. Application amounts are bounded safe integers and PostgreSQL stores them as `numeric(30,0)`. Project/tenant relationships are resolved from `projects.tenant_id`; caller-supplied ownership is never trusted.

## Admission and fairness

`src/governance/bootstrap.js` is loaded by the production API and worker npm entrypoints. It installs PostgreSQL-backed HTTP admission, durable job reservations, weighted fair job claiming, provider-execution reservations, and storage-operation/byte accounting. The migration also installs database guards on jobs, provider runs, storage objects and public runner execution rows so a future code path that bypasses the process hooks still cannot silently cross tenant boundaries or exceed active resource limits.

The distributed request limiter uses a PostgreSQL row lock on a bounded tenant/operation token bucket. Route keys contain only a bounded method and first three path segments; raw IDs are never cardinality keys. Sensitive writes, publishing, runner and artifact operations fail closed when quota storage is unavailable. Read-only traffic may degrade to the existing API controls.

Fair scheduling uses PostgreSQL `FOR UPDATE SKIP LOCKED` plus persistent `served_count / weight` state. A tenant with a large queue therefore cannot monopolize workers merely because its jobs are old.

## Reservations and crash recovery

`forge_quota_reservations` is the durable reservation ledger. Every reservation has an idempotency key, tenant/project identity, dimension, resource identity, policy version and expiry. Terminal jobs settle/release reservations. `TenantQuotaGovernance.reconcile()` settles expired reservations whose jobs are already terminal and expires abandoned holds for work that did not survive a crash. Duplicate requests, retries and duplicate callbacks converge on the same reservation identity.

The normal worker lease/retry system remains authoritative for job state; quota reconciliation never resurrects cancelled or superseded work.

## Operator API

All endpoints require the existing authenticated `OWNER` role and the operator tenant must match the target tenant.

- `GET /internal/governance/policy?tenantId=<tenant>&projectId=<optional>` — effective policy snapshot.
- `PUT /internal/governance/policy` — create a new immutable policy version. Body: `{ "projectId": "optional", "policy": { ... } }`.
- `POST /internal/governance/dry-run` — preview an admission for a dimension without creating a reservation.
- `GET /internal/governance/diagnostics` — active policies, reservation states, rate buckets and 24-hour usage.

Example policy:

```json
{
  "requests_per_minute": 240,
  "request_burst": 80,
  "concurrent_jobs": 16,
  "provider_executions": 12,
  "artifact_bytes": 53687091200,
  "storage_operations": 200000,
  "runner_executions": 6,
  "cpu_ms": 28800000,
  "wall_time_ms": 86400000,
  "reset_interval_seconds": 86400,
  "fairness_weight": 1,
  "sensitive_fail_closed": true,
  "dry_run": true
}
```

Use `dry_run=true` while tuning a new tenant/project policy. A policy update never mutates a previous policy version.

## Safe defaults

When no explicit policy exists, bounded defaults are 120 requests/minute with a burst of 60, 8 concurrent jobs, 8 provider executions, 20 GiB artifact storage, 100,000 storage operations/day, 4 public runner executions, 8 CPU-hours/day and 24 wall-clock hours/day. Operators should set explicit tenant policies before paid or adversarial workloads.

## Diagnostics and alerts

Use `/internal/governance/diagnostics` and the quota audit tables for scoped investigations. Do not add raw tenant IDs, job IDs or artifact IDs to Prometheus labels.

Recommended alerts:

- `forge_quota_reservations` has an increasing `HELD` population older than the reservation TTL.
- Repeated `QUOTA_EXCEEDED` admissions occur for one tenant/project.
- `forge_quota_rate_buckets` grows unexpectedly; stale buckets can be pruned after the retention window.
- Public runner active executions remain at a tenant limit while no corresponding job is running.
- Cross-tenant trigger errors or `TENANT_ISOLATION` events occur.

## Runbook

### Quota unexpectedly rejects work

1. Read the effective policy for the tenant/project.
2. Check `forge_quota_audit` for the denied dimension and projected usage.
3. Check `forge_quota_reservations` for unexpired holds.
4. Verify `forge_jobs`, `provider_runs`, `storage_objects` and `forge_execution_runs`.
5. Run quota reconciliation for abandoned reservations. Do not manually delete reservation rows.

### Rate limiting fails closed

Check PostgreSQL connectivity and `forge_quota_rate_buckets`. Sensitive writes intentionally return `503 QUOTA_UNAVAILABLE` rather than bypass distributed admission.

### Fairness looks wrong

Inspect `forge_quota_fairness`. `served_count / weight` is the scheduler virtual service score. Resetting fairness state is an operator action and should be performed only during a controlled maintenance window with audit evidence.

### Policy rollback

Do not edit an existing policy row. Create a new policy version with the desired previous values. This preserves the policy snapshot chain and avoids races with workers that already read the old version.

## PostgreSQL concurrency guarantees

Rate-limit buckets and reservation identities use row locks; job claims use `SKIP LOCKED`; duplicate requests/retries use unique idempotency keys; database triggers enforce cross-tenant and active-resource invariants. PostgreSQL `now()` is used for enforcement timestamps so host clock skew cannot extend a quota window.
