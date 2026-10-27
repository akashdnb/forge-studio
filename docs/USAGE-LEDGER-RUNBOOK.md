# Immutable Usage Ledger runbook

## Guarantees

- `usage_ledger_events` is append-only at the PostgreSQL trigger boundary.
- Each tenant has a serialized sequence and SHA-256 hash chain.
- `idempotency_key` is unique, so duplicate callbacks/retries/replays cannot create a second charge.
- Historical events retain their pricing version; repricing creates new adjustment evidence instead of mutating history.
- Quota reservations are serialized on the tenant policy row and are consumed/released exactly once.
- Provider reconciliation records every external event and its disposition before any corrective adjustment is applied.

## Production configuration

- `DATABASE_URL`: PostgreSQL connection string.
- `FORGE_USAGE_OPERATOR_TOKEN`: bearer token for the operator API. Store in the secret manager; never commit it.
- `FORGE_USAGE_OPERATOR_PORT`: operator API port (default `8091`).
- `FORGE_DB_POOL_MAX`: maximum operator connection pool (default `10`).

## Operator API

Run `node scripts/usage-ledger-operator.js` alongside the application. Every request requires both the operator bearer token and `x-tenant-id`.

- `GET /v1/usage/ledger` — inspect immutable events.
- `GET /v1/usage/totals` — current ledger totals by dimension/currency.
- `GET /v1/usage/integrity` — verify the tenant hash chain.
- `POST /v1/usage/reconcile` — reconcile provider/runner external usage.
- `POST /v1/usage/adjustments` — request a credit/refund/adjustment.
- `POST /v1/usage/adjustments/:id/decision` — approve/reject an adjustment.

## Reconciliation procedure

1. Freeze the affected provider window if the provider is returning unstable usage data.
2. Run reconciliation using the provider's immutable event identifiers.
3. Investigate `MISSING_INTERNAL`, `EXTERNAL_ONLY`, `QUANTITY_MISMATCH`, `AMOUNT_MISMATCH`, and `DUPLICATE` rows.
4. Do not edit ledger rows. Create an approved adjustment or a corrective usage event with a new idempotency key.
5. Re-run reconciliation and verify `/v1/usage/integrity` is valid.
6. Record the incident/change reference in the adjustment note.

## Suspected ledger corruption

1. Stop billing exports/settlement for the tenant.
2. Call `/v1/usage/integrity` and capture the first invalid sequence/event.
3. Preserve PostgreSQL logs and a read-only snapshot.
4. Never repair by `UPDATE`/`DELETE`. The database intentionally rejects both operations.
5. Resolve by appending a documented corrective event after root-cause review.

## Quota exhaustion

A hard limit rejects new reservations with `QUOTA_EXCEEDED`. Soft limits are advisory and should drive capacity/budget alerts. Grace is additive to the hard limit and must be explicit in the tenant policy. Existing work may finish after a reservation has been consumed; no implicit refund is performed for a cancelled job.

## Retry/cancellation policy

Usage is charged at the authoritative `usage_events` INSERT boundary. A failed attempt is billable if the provider/runner emitted billable usage and the usage event was accepted; retries use distinct execution-attempt identifiers but the event idempotency key prevents duplicate callbacks. Cancellation releases only an unconsumed quota reservation; already-consumed provider usage remains immutable and is refundable only through an approved adjustment.
