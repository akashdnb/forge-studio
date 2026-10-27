# Operations Control Plane

Forge exposes an OWNER-only operations backend at `/v1/ops`. It is intended for incident response, not ordinary workflow mutation.

## Security contract

- Authentication uses the same signed Forge identity as the main API (`FORGE_AUTH_SIGNING_SECRET`) or the existing static operator token.
- Every operations request is tenant-scoped. Resource lookup is performed through the project/episode graph before any mutation.
- Privileged mutations require an explicit reason (8–1000 characters) and an idempotency key.
- Operator actions never accept arbitrary state values. Each action checks the current durable state and optional `expectedStatus` precondition.
- Retry/requeue is rejected for jobs whose kind represents externally visible side effects such as publishing or handoff.
- Fencing and expired-lease recovery change the durable worker identity and dispatch generation so a stale worker cannot complete the superseded job.
- Artifact quarantine changes lifecycle state only; it never rewrites immutable artifact content or provenance.
- Bulk operations are capped at 25 targets, require a short-lived preview confirmation token, and consume the token exactly once.
- Responses redact credentials, tokens, secrets, passwords and authorization values.

## Read endpoints

- `GET /v1/ops/health`
- `GET /v1/ops/incidents`
- `GET /v1/ops/search?q=...`
- `GET /v1/ops/projects`
- `GET /v1/ops/episodes`
- `GET /v1/ops/versions`
- `GET /v1/ops/jobs`
- `GET /v1/ops/jobs/:id`
- `GET /v1/ops/workers`
- `GET /v1/ops/providers`
- `GET /v1/ops/artifacts`
- `GET /v1/ops/audit`

All list endpoints enforce bounded `limit`/`offset` pagination. Incident views cover stuck jobs, retry exhaustion, expired leases, dependency blockage, provider failures, quarantined artifacts and budget exhaustion when usage tables are present.

## Mutations

`POST /v1/ops/actions/:action` supports guarded actions for jobs (`cancel`, `retry`, `requeue`, `fence`, `recover`), artifacts (`quarantine`) and operational resources (`disable`, `enable`). A provider reconciliation command can be issued with `action=reconcile` once the provider target is enabled.

Example:

```json
{
  "targetType": "job",
  "targetId": "job-123",
  "reason": "Worker lease expired during render recovery",
  "expectedStatus": "RUNNING",
  "idempotencyKey": "operator-incident-2026-10-27-job-123"
}
```

Use `dryRun:true` to validate a command without changing the target.

## Bulk procedure

1. `POST /v1/ops/bulk/preview` with `action`, bounded `targets`, and `reason`.
2. Review the returned scope and short-lived `confirmationToken`.
3. `POST /v1/ops/bulk/execute` with that token and the exact target set.
4. Keep the returned request/audit identifiers with the incident record.

## Incident runbook

### Stuck or expired jobs

Inspect `/v1/ops/incidents` and `/v1/ops/jobs/:id`. If `leased_until < now()`, prefer `recover`; if a worker is still processing an unsafe execution, fence first. Never manually set a worker ID or job state through SQL.

### Retry exhaustion

Do not increase `max_attempts` from the control plane. Investigate provider failure, dependency blockage, provenance and budget state first. Retry only failed jobs with remaining retry budget and no external side effect.

### Provider outage

Use `/v1/ops/providers` to inspect recent failure ratios and `/v1/ops/audit` to identify previous operator interventions. Disable a provider before an incident storm is allowed to create more provider runs; the database guard rejects new provider runs for disabled providers.

### Artifact corruption

Use `/v1/ops/artifacts` and quarantine the affected immutable artifact. Reconciliation/storage tooling remains authoritative for checksum repair. Never overwrite a content-addressed artifact in place.

### Budget exhaustion

Treat budget state as an admission-control problem. Do not bypass usage reservations or edit usage records from the operations API.

### Release/migration drift

Use the existing release-safety and migration diagnostics before changing production state. The operations plane deliberately does not expose arbitrary migration execution or release-state editing.

## Operational limits

`FORGE_OPS_PG_POOL_MAX` controls the dedicated operations connection pool (default 5). Request bodies are capped at 256 KiB; bulk scope is capped at 25 targets; list queries are bounded to 100 rows per request. Clean expired confirmation/idempotency rows as part of normal database maintenance.
