# Episode Cost, Usage, Quota and Budget Enforcement

Forge records an immutable usage event for each worker execution attempt and gates execution with a durable reservation. Admission is concurrency-safe across workers because the applicable global, project, episode and provider budgets are row-locked before a reservation is created.

## Enable enforcement

Set:

```text
FORGE_COST_ENFORCEMENT_ENABLED=true
FORGE_USAGE_RESERVATION_TTL_MS=900000
FORGE_USAGE_RECOVERY_INTERVAL_MS=60000
```

When enforcement is enabled, missing pricing or a missing global budget is fail-closed. Do not enable production enforcement until pricing and at least one global budget are configured.

### Pricing configuration

`FORGE_USAGE_PRICING_JSON` is a JSON array. Pricing can be exact or wildcarded by using an empty provider/model. Supported unit types are `request`, `second`, `byte`, `input_unit`, `output_unit`, and `custom`.

Example:

```json
[
  {"providerType":"worker","provider":"workflow:narration","model":"","operation":"workflow:narration","unitType":"request","unitPrice":0.01,"currency":"USD","configVersion":"2026-10"},
  {"providerType":"provider","provider":"openai","model":"gpt-5","operation":"generation","unitType":"request","unitPrice":0.02,"currency":"USD","configVersion":"2026-10"}
]
```

### Budget configuration

`FORGE_USAGE_BUDGETS_JSON` accepts `GLOBAL`, `PROJECT`, `EPISODE`, and `PROVIDER` scopes. A global budget is required when enforcement is enabled. Limits are lifetime unless a different `periodKey` is supplied.

```json
[
  {"scopeType":"GLOBAL","scopeId":"global","hardCostLimit":1000,"hardUsageLimit":100000,"currency":"USD","configVersion":"2026-10"},
  {"scopeType":"PROJECT","scopeId":"project-123","hardCostLimit":100,"currency":"USD","configVersion":"2026-10"},
  {"scopeType":"EPISODE","scopeId":"episode-123","hardCostLimit":20,"currency":"USD","configVersion":"2026-10"},
  {"scopeType":"PROVIDER","scopeId":"openai","hardCostLimit":500,"currency":"USD","configVersion":"2026-10"}
]
```

## Lifecycle

1. The durable job is leased.
2. Usage accounting resolves pricing and calculates a bounded estimate.
3. Global/project/episode/provider hard limits are checked while budget rows are locked.
4. A deterministic, attempt-scoped reservation is created.
5. Only then does the worker call the expensive handler/provider.
6. Success/failure/cancellation settles or releases the reservation and records an immutable event.
7. Duplicate callbacks use the deterministic event identity and are ignored.
8. Stale reservations are recovered by the worker. Recovery records the reserved estimate as a bounded failure event and marks the reservation `EXPIRED` so abandoned capacity cannot block future work forever.

Retries receive a new reservation and execution identity (`jobId + attempt`) so every provider/worker execution remains independently accounted while duplicate delivery of the same callback remains idempotent.

## API visibility

Authenticated read-only endpoints:

- `GET /v1/usage/health`
- `GET /v1/usage/episodes/:episodeId`
- `GET /v1/usage/projects/:projectId`
- `GET /v1/usage/providers/:provider`

The health endpoint exposes enforcement state, budget states, reservation states and aggregate actual cost without exposing provider secrets or raw payloads.

## Operational checks

If jobs stop at admission, inspect `/v1/usage/health` and the worker logs for `PRICING_UNAVAILABLE`, `BUDGET_CONFIGURATION_UNAVAILABLE`, or `BUDGET_REJECTED`. Do not bypass admission by invoking provider handlers directly. Update pricing/budget configuration and restart/redeploy the worker so configuration is synchronized.

Reservations are bounded by `FORGE_USAGE_RESERVATION_TTL_MS`. A stale reservation is not silently discarded: it produces an immutable recovery event and an auditable `EXPIRED` terminal state.
