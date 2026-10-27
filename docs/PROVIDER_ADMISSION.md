# Provider execution admission

Provider execution is admitted before the existing reliability/retry and forge-runner paths. Policies are durable, tenant/project scoped and immutable by epoch: project+provider+model+operation is most specific, followed by progressively broader scopes. An update creates a new epoch and deactivates the prior row.

Admission atomically uses PostgreSQL time and an advisory transaction lock to expire stale leases, enforce provider/model/operation concurrency, consume a token-bucket rate limit, and persist decision evidence. Duplicate idempotency keys reuse a live lease. A provider health `OPEN` state is also fenced by the policy cooldown before a call is attempted. Candidate priority is multiplied by policy weight so weighted priority influences existing health-router failover ordering.

The admission then reserves the existing tenant `provider_executions` quota and cost-governance budget. If spend or quota admission fails, the provider is never called. On success/failure the durable admission lease and governance reservations settle exactly once. No credentials, provider payloads or response bodies are stored in admission evidence.

## Operator API

OWNER-authenticated, tenant-isolated endpoints:

- `GET /internal/provider-admission/policies?tenantId=<tenant>`
- `PUT /internal/provider-admission/policies`
- `GET /internal/provider-admission/diagnostics?tenantId=<tenant>&projectId=<project>`
- `GET /internal/provider-admission/metrics?tenantId=<tenant>`

Policy fields include priority, weight, max concurrency, rate/burst, lease/cooldown, half-open probe allowance and optional spend ceiling. Every mutation increments the policy epoch under a PostgreSQL advisory lock.

## Runbook

- **Concurrency/rate backpressure:** leave the durable job queued; never bypass admission in a worker.
- **Circuit open:** inspect provider health state plus admission decisions. Reduce policy weight/concurrency during flapping and restore gradually.
- **Stale lease:** reconcile the job/runner lease. Admission uses database time and expires abandoned claims before counting capacity.
- **Duplicate retry/callback:** preserve the same idempotency key; a live admission lease is reused.
- **Partial outage:** rely on existing health-router failover after admission rejects unhealthy/limited candidates. Credential, tenant, model, operation and release fences remain hard constraints.
- **Policy rollout:** use diagnostics to verify the new epoch before changing routing priorities.

## Validation

```bash
npm run check
npm test
DATABASE_URL='postgres://...' node --test test/provider-admission.postgres.test.js
```

Migration `111_provider_execution_admission.sql` is checked for unique numeric ordering and follows the current migration frontier. The PostgreSQL suite covers concurrent claims, idempotency, stale leases and injected database failure.
