# Cost attribution, usage metering and spend guardrails

Forge cost enforcement is an execution control, not a reporting dashboard. When `FORGE_COST_ENFORCEMENT_ENABLED=true`, scheduler admission and worker admission fail closed unless a tenant-attributed job has a matching price/rate version and an active global budget.

## Model

- `cost_rate_versions` is append-only pricing/rate history. Reservations/events capture provider, model, operation, unit price, rate version, source currency, normalized currency and FX rate.
- `cost_budget_epochs` is immutable budget history with one active epoch per scope/period/currency. Supported scopes: GLOBAL, TENANT, PROJECT, EPISODE, RUN and PROVIDER.
- `cost_reservations` is the admission ledger. Reservations are attempt-scoped and idempotent, carry priority, release epoch and the exact budget epochs evaluated at admission.
- `cost_events` is append-only immutable execution evidence. Reconciliation/refunds append `cost_adjustments` and never mutate events.
- `cost_budget_overrides` provides bounded, expiring operator headroom and is audited.

## Admission lifecycle

1. Scheduler claims a durable job using existing capacity controls.
2. Cost admission resolves tenant/project/episode/run attribution and locks applicable budget epochs.
3. Projected spend includes committed ledger cost plus live held reservations. Hard limits reject; soft limits may require higher priority.
4. The reservation captures the exact price/rate/budget/release snapshots before expensive work.
5. Worker accounting reuses the same attempt reservation, preventing double charging.
6. Success/failure/cancellation commits/releases the reservation and appends one immutable event.
7. Retries use a new attempt key; duplicate callbacks converge on the existing event.
8. Stale reservations expire with an immutable zero-cost recovery event.

Runner, media, storage, packaging and publishing work normally enter Forge through durable jobs, so scheduler/worker admission protects those execution paths before handlers dispatch expensive work.

## Units and rates

Supported deterministic units: `request`, `second`, `byte`, `input_unit`, `output_unit`, `cpu_ms`, `custom`. A rate version fixes the unit price and FX snapshot used for admission and settlement. Later price changes do not rewrite history.

## Operator APIs

OWNER-only authenticated, tenant-scoped endpoints:

- `GET /v1/cost/health`
- `GET /v1/cost/budgets` (requires an owned TENANT/PROJECT/EPISODE scope)
- `GET /v1/cost/rates`
- `POST /v1/cost/budgets` (TENANT/PROJECT/EPISODE scopes)
- `POST /v1/cost/overrides` (TENANT/PROJECT/EPISODE scopes)
- `POST /v1/cost/reconcile` (events belonging to the caller's tenant)

Rate versions and platform/global budgets are deployment/system configuration, not mutable by a tenant OWNER. Historical cost events remain database-immutable.

## Configuration

```text
FORGE_COST_ENFORCEMENT_ENABLED=true
FORGE_COST_RESERVATION_TTL_MS=900000
FORGE_USAGE_PRICING_JSON=[...]
FORGE_USAGE_BUDGETS_JSON=[...]
```

When enforcement is enabled, missing tenant attribution, missing rates, missing global budget or currency mismatch fails closed rather than silently bypassing spend controls.

## Runbook

1. Check `/v1/cost/health` plus scheduler/worker diagnostics.
2. Inspect rejected events and their captured `price_version`, `budget_epoch_ids` and release epoch.
3. Never mutate/delete immutable cost events.
4. Reconcile provider invoice differences through `POST /v1/cost/reconcile`; the delta is append-only.
5. Use short-lived, reasoned overrides for emergency bounded headroom; never disable enforcement as a bypass.
6. Publish a new rate version for provider/FX changes through deployment/system configuration.
7. Allow stale-recovery to expire abandoned reservations; reconcile downstream provider receipts before manually taking any action.

## Validation

- `node --check src/cost/cost-governance.js`
- `node --check src/cost/config-sync.js`
- `node --check src/cost/budget-config.js`
- `node --check src/cost/bootstrap.js`
- `node --check src/cost/http.js`
- `node --test test/cost-governance.test.js`
- `TEST_DATABASE_URL=... node --test test/cost-governance.test.js`
- `node src/migrate.js`
