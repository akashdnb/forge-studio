# Provider execution admission

Forge executes provider-backed work through one deterministic admission layer before the provider call. It combines durable tenant/project policy epochs with the existing provider health router, credential fencing, tenant quotas, cost budgets and durable job/runner leases.

## Policy precedence

A policy is selected by most-specific scope in this order: project + provider + model + operation, project + provider + model, project + provider, tenant + provider + model + operation, tenant + provider, then tenant defaults. A policy update never mutates an old row: it creates the next `epoch` and deactivates the previous row. Provider decisions persist the epoch so an operator can prove which policy admitted a run.

The effective policy contains priority, weight, concurrency, rate/burst, lease and circuit settings plus an optional spend ceiling. Priority is multiplied by weight before the existing health router ranks candidates. Provider/model/operation compatibility, credentials and release epochs remain hard fences; no fallback is allowed to bypass them.

## Admission lifecycle

1. Resolve tenant/project ownership from the request or episode.
2. Select the immutable active policy epoch.
3. Serialize the provider scope with a PostgreSQL advisory transaction lock.
4. Expire stale leases using PostgreSQL time, then enforce concurrency and token-bucket rate limits.
5. Persist an admission decision without credentials or provider payloads.
6. Reserve existing tenant provider-execution quota and cost budget through the established governance layers.
7. Execute the already-routed provider through the existing reliability/circuit/retry path.
8. Settle the admission lease and governance reservations exactly once.

Duplicate idempotency keys reuse a live lease. Expired leases are recoverable. Policy changes cannot silently rewrite a decision already persisted under an older epoch.

## Operator API

Authenticated OWNER requests may use:

- `GET /internal/provider-admission/policies?tenantId=<tenant>&projectId=<project>`
- `PUT /internal/provider-admission/policies`
- `GET /internal/provider-admission/diagnostics?tenantId=<tenant>&projectId=<project>`
- `GET /internal/provider-admission/metrics?tenantId=<tenant>`

The authenticated tenant is mandatory. Supplying another tenant is rejected. Responses contain policy and decision metadata only; credentials, bearer tokens, request payloads and provider response bodies are never returned.

Example policy body:

```json
{
  "projectId": "project-1",
  "provider": "openai-compatible",
  "model": "gpt-5",
  "operation": "script",
  "policy": {
    "priority": 120,
    "weight": 2,
    "maxConcurrency": 4,
    "ratePerSecond": 2,
    "burst": 4,
    "leaseMs": 120000,
    "cooldownMs": 30000,
    "failureThreshold": 5,
    "failureRateThreshold": 0.5,
    "halfOpenMaxCalls": 1,
    "spendLimitUsd": 25
  }
}
```

## Failure modes and runbook

- **Concurrency/rate rejection:** leave the job queued/backpressured; do not bypass admission in a worker.
- **Circuit open:** inspect `provider_health_state`, recent health events and admission decisions. Let the bounded half-open probe recover the provider.
- **Provider flapping:** reduce weight/priority, tighten concurrency, and allow health EWMA/failure windows to stabilize before restoring traffic.
- **Stale leases:** reconcile the durable job/runner lease first. Admission uses database time and automatically expires leases before counting capacity.
- **Duplicate callback/retry:** preserve the original idempotency key. A second attempt must not create another live admission lease.
- **Policy rollout:** verify the new epoch in diagnostics before changing provider order. Existing runs retain their admission evidence.
- **Partial outage:** keep failover limited to idempotent, contract-compatible candidates. Never fail over across tenant, model, operation, credential or release fences.

## Validation

Apply migrations in lexical numeric order; `111_provider_execution_admission.sql` follows the current `110` migration. Run:

```bash
npm install
npm run check
DATABASE_URL='postgres://...' npm run migrate
DATABASE_URL='postgres://...' node --test test/provider-admission.postgres.test.js
```

The PostgreSQL suite exercises concurrent claims, idempotency, stale lease recovery and an injected database failure. The normal `npm test` suite remains authoritative for existing provider reliability, capacity, credential and cost governance behavior.
