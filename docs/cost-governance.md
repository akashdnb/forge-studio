# Cost attribution, usage metering and spend guardrails

Forge cost enforcement is an execution control, not a reporting dashboard. When `FORGE_COST_ENFORCEMENT_ENABLED=true`, scheduler admission and worker admission fail closed unless a tenant-attributed job has a matching price/rate version and an active global budget.

## Model

- `cost_rate_versions` is append-only pricing/rate history. Each reservation and cost event captures provider type, provider, model, operation, unit type, unit price, price version, source currency, normalized currency and FX rate.
- `cost_budget_epochs` is immutable budget history with one active epoch per scope/period/currency. Supported scopes: GLOBAL, TENANT, PROJECT, EPISODE, RUN and PROVIDER.
- `cost_reservations` is the admission ledger. Reservations are attempt-scoped and idempotent, carry priority, release epoch and the exact budget epoch set evaluated at admission.
- `cost_events` is append-only immutable execution evidence. Refunds/reconciliation never mutate an event; they append `cost_adjustments`.
- `cost_budget_overrides` provides bounded, expiring operator headroom and is itself audited.

## Deterministic units

Supported units are `request`, `second`, `byte`, `input_unit`, `output_unit`, `cpu_ms` and `custom`. A rate version determines the unit and price. The same rate snapshot is used for admission and settlement; later price changes do not rewrite history.

Job categories are inferred for real execution paths: provider calls, forge-runner/GitHub execution, media/CPU work, storage/artifact operations, publishing and generic workflow work.

## Admission lifecycle

1. Scheduler claims a durable job using the existing capacity controls.
2. Cost admission resolves tenant/project/episode/run attribution and locks all applicable active budget epochs in deterministic scope order.
3. The projected cost includes committed ledger cost plus live held reservations. Hard limits reject; soft limits can require higher priority.
4. A reservation records price/rate/budget/release snapshots before expensive work starts.
5. Worker accounting reuses the same attempt reservation, so scheduler and worker admission are idempotent rather than double charging.
6. Success/failure/cancellation commits or releases the reservation and appends one immutable cost event.
7. Retries get a new attempt/idempotency key. Duplicate callbacks converge on the existing event.
8. Stale reservations become `EXPIRED` with an immutable zero-cost recovery event.

Runner, media, packaging and publishing work normally enter Forge through durable jobs, so the scheduler/worker gate protects those execution paths before their handlers execute. Direct provider callers should use the same `CostGovernanceService.reserveForJob/settleJob` boundary when they bypass the durable queue.

## Operator APIs

All `/v1/cost/*` mutation endpoints require an authenticated OWNER and tenant-scoped authorization.

- `GET /v1/cost/health`
- `GET /v1/cost/budgets`
- `GET /v1/cost/rates`
- `POST /v1/cost/budgets`
- `POST /v1/cost/rates`
- `POST /v1/cost/overrides`
- `POST /v1/cost/reconcile`

Budget/rate updates create new versions; immutable execution history is never edited. Reconciliation appends a signed adjustment record and an audit event.

## Configuration

```text
FORGE_COST_ENFORCEMENT_ENABLED=true
FORGE_COST_RESERVATION_TTL_MS=900000
FORGE_USAGE_PRICING_JSON=[...]
FORGE_USAGE_BUDGETS_JSON=[...]
```

The environment JSON remains useful for bootstrapping local/staging pricing. Production operator changes should use the authenticated cost APIs so budget epochs and rate versions are durable and audited.

Budget currency must match the normalized currency of the applicable rate version. If enforcement is enabled and the global budget or normalized currency is unavailable, admission fails closed rather than silently bypassing spend control.

## Incident / reconciliation runbook

1. Check `GET /v1/cost/health` and scheduler/worker diagnostics.
2. Inspect rejected admission events by tenant/project and the captured `price_version` / `budget_epoch_ids`.
3. Do not mutate cost events or manually delete reservations.
4. For a provider invoice correction, call `POST /v1/cost/reconcile`; the difference is appended as an immutable adjustment.
5. For emergency bounded headroom, create a short-lived operator override with a reason and request ID. Never disable enforcement to bypass a budget.
6. After provider/currency changes, publish a new rate version with an explicit effective time and FX snapshot.
7. If a worker died after reservation, allow stale-recovery to expire the lease or run the bounded recovery job; do not manually mark committed spend.

## Validation

- `node --check src/cost/cost-governance.js`
- `node --check src/cost/bootstrap.js`
- `node --check src/cost/http.js`
- `node --test test/cost-governance.test.js`
- With PostgreSQL: `TEST_DATABASE_URL=... node --test test/cost-governance.test.js`
- Full migration validation: `node src/migrate.js`

The PostgreSQL tests intentionally exercise concurrent reservations and a failure-injection/recovery path. They are skipped when no test database is configured.
