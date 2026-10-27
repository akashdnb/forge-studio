# Transactional Outbox, Durable Delivery and Event Ordering

Forge now treats important asynchronous state transitions as database facts first and worker work second.

## Guarantees

- **Atomic capture:** state changes and their event/outbox rows commit in the same PostgreSQL transaction. A committed transition therefore cannot disappear between the state write and worker dispatch.
- **Immutable identity:** events have stable IDs, tenant/project identity, aggregate identity, per-aggregate sequence, schema name/version and SHA-256 payload hashes. Event identity and payload cannot be mutated after insert.
- **Tenant isolation:** event and outbox rows carry tenant/project scope and are protected by the existing project/tenant constraints.
- **Redaction:** event payloads are recursively redacted for credentials, tokens, secrets, cookies, authorization headers and key material before delivery.
- **Causal context:** events can carry run ID, workflow-version ID, causation ID and correlation ID.
- **Ordered parallelism:** ordered subscriptions serialize work by `(subscription, ordering_key, ordering_sequence)` while unrelated aggregates can be delivered concurrently.
- **Fencing:** both outbox fanout and delivery use expiring lease tokens. Completion is accepted only when the current token still owns the row.
- **At-least-once delivery with idempotency:** delivery IDs are deterministic per `(event, subscription)`, and consumer cursors suppress stale replay after an acknowledgement.
- **Poison-event quarantine:** exhausted outbox/delivery retries enter dead-letter/quarantine state instead of being retried forever.

## Captured production paths

Database triggers capture transitions from the authoritative tables for workflow episodes, jobs, provider/runner executions, publishing, approvals, QA, audit events, workflow execution plans, version creation, artifacts and operational incidents. Existing event triggers remain transaction-local; the hardened capture function enriches the same event with ordering and integrity metadata.

## Worker lifecycle

1. Claim pending outbox rows with `FOR UPDATE SKIP LOCKED`.
2. Fence each row with a random lease token and expiry.
3. Materialize subscription deliveries using deterministic delivery IDs.
4. Mark the outbox row published only with the same fencing token.
5. Claim delivery rows with a second lease/fencing token.
6. For ordered consumers, refuse to advance past an earlier non-terminal event on the same ordering key.
7. POST the redacted event with event ID, ordering and correlation headers.
8. Record the attempt and acknowledgement. Advance the consumer cursor monotonically.
9. Retry transient failures with jittered exponential backoff. Quarantine poison events after the configured attempt limit.
10. Recover expired leases after worker crashes or process restarts.

## Operator controls

The durable event API exposes:

- `GET /healthz` — database-backed delivery health.
- `GET /v1/event-delivery/metrics` — backlog, status, dead-letter and stale-lease counts.
- `GET /v1/event-diagnostics` — event/outbox/delivery evidence for the tenant.
- `GET /v1/event-deliveries` — inspect delivery state and acknowledgement metadata.
- `POST /v1/event-deliveries/:id/replay` — replay a terminal delivery through the normal ordered path.
- `POST /v1/event-deliveries/:id/cancel` — operator cancellation with security audit evidence.

Replay is intentionally not a direct send. It re-enters the durable delivery state machine, so ordering, fencing and idempotency still apply.

## Failure and recovery runbook

### Worker crash

Do nothing immediately. The lease expires and the next worker recovers it. Check `/healthz` and `staleLeases` if recovery is delayed.

### Network partition / provider endpoint unavailable

Inspect retrying deliveries and `last_error`. Transient HTTP failures back off automatically. Do not manually duplicate the event; use replay only after the downstream endpoint is healthy.

### Poison event

After the delivery attempt limit, inspect the delivery and DLQ/quarantine reason. Fix the consumer contract first, then replay the delivery. The event ID remains unchanged.

### Ordering stall

Inspect `/v1/event-diagnostics` filtered by `orderingKey`. The first non-terminal event on an ordered key is the serialization point. Resolve or replay that event before later events are released.

### Suspected stale worker

The fencing token prevents an old worker from committing after its lease was taken over. If a worker repeatedly loses fencing, restart it and inspect database/network latency before increasing lease duration.

## Configuration

Relevant environment settings include:

- `FORGE_EVENT_POLL_MS` — worker polling interval.
- `FORGE_EVENT_FANOUT_BATCH` — outbox rows claimed per tick.
- `FORGE_EVENT_DELIVERY_BATCH` — delivery rows claimed per tick.
- `FORGE_EVENT_RECOVERY_EVERY` — lease-recovery cadence in ticks.
- `FORGE_EVENT_PG_POOL_MAX` — event worker PostgreSQL pool size.
- `FORGE_EVENT_SECRET_KEY` — encryption key material for webhook subscription secrets.

The default delivery lease is 60 seconds and the default maximum delivery attempts is 8; outbox quarantine defaults to 12 attempts. Keep lease duration comfortably above normal database plus downstream request latency.

## Schema evolution

Event schema versions are persisted with each immutable event. New fields should be additive. A breaking consumer change requires a new schema version and consumer rollout before old versions are retired. Replays always use the persisted event version rather than reconstructing state from current database rows.

## Evidence and diagnostics

The event record, outbox row, delivery attempts, consumer cursor and DLQ row form a durable chain that can be correlated by event ID. This is the primary evidence path for proving whether a state transition was committed, dispatched, acknowledged, retried or quarantined.
