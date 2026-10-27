# Inbound Event Intake, Quarantine and Replay Runbook

## Invariants

- The durable `forge_inbound_events` row and its processing job are accepted atomically by the existing signed-ingress transaction.
- `forge_event_intake` is the append-oriented operational intake ledger. Identity fields (tenant/project, endpoint, source/provider, schema/version, payload hash and deduplication key) are database-immutable.
- Raw payloads, secrets and authorization material are never persisted by the intake ledger; only bounded metadata and SHA-256 digests are retained.
- Duplicate delivery is deterministic on `(endpoint, external event identity, payload hash)`. Conflicting reuse of an external identity remains a hard rejection.
- Replay requires authenticated operator authorization and a short-lived PostgreSQL replay claim. Concurrent operators cannot hold the same active `(event, route)` replay claim.

## Ingress safety

1. Resolve the endpoint to a tenant/project before accepting an event.
2. Bound raw request bytes before JSON parsing.
3. Authenticate the exact raw bytes with the canonical HMAC request format.
4. Enforce the configured timestamp window and nonce uniqueness.
5. Validate event type/version before downstream execution.
6. Persist the intake observation and let the existing event/job transaction establish the durable execution boundary.

## Quarantine

A downstream permanent failure must end in the existing inbound DLQ rather than executing again silently. The hardening layer mirrors the terminal state into `forge_event_intake` as `QUARANTINED` with the bounded failure reason and increments the attempt count. Retryable provider/network failures remain under the durable job retry budget.

## Replay

- Confirm tenant/project ownership and the event's current effect state.
- Use the authenticated operator replay API; never mutate workflow/provider state manually.
- A replay claim is created under a row lock and an active unique index prevents concurrent claims.
- If the downstream cause is fixed, enqueue the existing idempotent inbound job and release the claim as `RELEASED`/`COMPLETED`.
- If replay fails again, leave the event quarantined and investigate the recorded failure rather than increasing the retry budget indefinitely.

## Ordering and gaps

Where a provider supplies a monotonic sequence, map it to a stable stream key and maintain `forge_event_order_watermarks`. A forward jump records a gap instead of silently advancing the consumer. Do not infer ordering for event types that do not provide an ordering contract.

## Retention

`FORGE_INBOUND_RETENTION_DAYS` controls the intake ledger retention horizon and defaults to 90 days. The retention timestamp is metadata only; deletion jobs must honor legal holds and the existing audit/evidence retention policy before removing records.

## Monitoring

Watch for:

- rejected signature/nonce events,
- duplicate and conflicting identities,
- `RECEIVED`/`PROCESSING` lag,
- quarantine/DLQ growth,
- ordering gaps,
- repeated replay claims,
- retention backlog.

Use existing tenant-scoped inbound metrics plus direct SQL diagnostics against `forge_event_intake` for incident response. Correlate by event ID, intake ID and payload hash; do not paste raw provider payloads or secrets into tickets.

## Failure injection checklist

Validate at least once in a disposable PostgreSQL environment:

- crash after intake observation but before event acceptance,
- crash after event/job commit but before worker execution,
- duplicate concurrent deliveries,
- stale timestamp and clock skew,
- duplicate nonce and conflicting event identity,
- malformed/oversized body,
- provider failover and retry storm,
- worker lease expiry during an inbound effect,
- two concurrent operator replays,
- schema version rejection and later supported-version replay,
- retention deletion with a protected/legal-held event.
