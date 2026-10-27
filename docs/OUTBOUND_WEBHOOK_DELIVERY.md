# Outbound Webhook Delivery Runbook

Forge outbound webhooks are an at-least-once, PostgreSQL-backed delivery subsystem built on the existing transactional event outbox. Events are immutable evidence; delivery rows reference the event rather than reconstructing current application state.

## Production guarantees

- Tenant/project scope is persisted on events, subscriptions, deliveries and operator evidence.
- Endpoint configuration is snapshotted onto each delivery so changing or deleting an endpoint cannot redirect already-created work.
- Delivery IDs are deterministic for `(event, subscription, delivery_epoch)`; replay creates a new epoch while retaining the original event ID and evidence.
- Payload and schema hashes are persisted. Payloads are redacted before outbound delivery; secret material is encrypted and never logged.
- Each attempt receives a fresh nonce and timestamp. The signature covers `timestamp.nonce.body` and the idempotency key is stable for the delivery.
- DNS is resolved immediately before send, private/mixed address results are rejected, and the resolved public address is pinned for the HTTP request. Redirects are not followed.
- `2xx` acknowledges. `3xx` and non-retryable `4xx` are terminal failures. `408`, `409`, `425`, `429`, `5xx`, timeouts and network errors retry with bounded jittered exponential backoff; `Retry-After` is honored.
- Endpoint concurrency/rate limits, ordering cursors, lease fencing and circuit breakers prevent duplicate worker ownership and retry storms.
- Exhausted deliveries are quarantined in the DLQ. Replay/release/circuit-reset/key-rotation actions require operator authorization and durable audit evidence.

## Operator APIs

- `GET /v1/event-subscriptions` — tenant-scoped endpoint inventory.
- `POST /v1/event-subscriptions` — create an endpoint; requires an allowed governance decision.
- `GET /v1/event-subscriptions/:id/inspect` — endpoint health, delivery counts and recent latency.
- `PATCH /v1/event-subscriptions/:id` — change endpoint configuration, activation, ordering or limits; endpoint URL changes create a new delivery epoch.
- `POST /v1/event-subscriptions/:id/rotate-secret` — rotate the active signing key without invalidating in-flight deliveries pinned to the prior key.
- `POST /v1/event-subscriptions/:id/circuit-reset` — close an open circuit after the downstream issue is understood.
- `GET /v1/event-deliveries` — inspect immutable delivery state and attempt metadata.
- `POST /v1/event-deliveries/:id/replay` — create a new delivery epoch from immutable event evidence; never sends directly from the API.
- `POST /v1/event-deliveries/:id/quarantine-release` — release a dead-lettered delivery back to the normal worker state machine.
- `GET /v1/event-delivery/metrics` — backlog, stale leases, DLQ and circuit state.

## Incident response

### Endpoint is failing

Inspect the endpoint and recent deliveries. Check `last_error`, response status, retry age, circuit state and downstream health. Do not create duplicate subscriptions to work around a failing endpoint.

### Circuit is OPEN

Fix the downstream failure first. Reset the circuit with the operator API only after confirming the endpoint is healthy. The next claim acts as a half-open probe.

### Delivery is DEAD_LETTER

Inspect the event payload/schema hash and attempt history. Fix the consumer contract or endpoint configuration, then use `quarantine-release` or replay. Never mutate the original event.

### Worker crash or stale lease

The delivery lease is fenced. A stale worker cannot commit a completion after another worker owns the row. Recovery moves expired `IN_FLIGHT` deliveries to `RETRY`.

### Secret rotation

Rotate through the endpoint API. New deliveries use the new key epoch; existing deliveries retain the key ID captured at creation. Keep retired key material available until all deliveries referencing that key are terminal.

### Suspected SSRF/DNS abuse

A request is rejected if the literal host or any DNS result is private, loopback, link-local, carrier-grade, documentation/test, multicast or otherwise non-public. Redirects are never followed. Review the endpoint configuration reference and audit evidence rather than manually overriding the network policy.

## Failure-injection checklist

Validate before release:

1. Two workers claim the same delivery concurrently; exactly one receives the lease.
2. Worker crashes after downstream acknowledgement; retry uses the same idempotency key and cannot advance a stale lease.
3. Endpoint returns `429` with `Retry-After`; retry is delayed accordingly.
4. Endpoint returns `302`; no redirect is followed and the delivery fails terminally.
5. Endpoint returns repeated `503`; circuit opens after the configured threshold.
6. DNS returns a public and private address; the request is rejected.
7. Endpoint secret rotates while an old delivery is retrying; the old delivery retains its original key ID.
8. Endpoint URL changes; existing delivery snapshots continue targeting the old configuration while new events use the new epoch.
9. A tenant attempts to inspect, replay or mutate another tenant's delivery; the request is denied.
10. A replay storm is attempted; each replay receives a distinct delivery epoch and is still rate/concurrency limited.

## Configuration

Relevant environment settings include `FORGE_EVENT_SECRET_KEY`, `FORGE_EVENT_MAX_ATTEMPTS`, `FORGE_EVENT_POLL_MS`, `FORGE_EVENT_FANOUT_BATCH`, `FORGE_EVENT_DELIVERY_BATCH`, `FORGE_EVENT_RECOVERY_EVERY`, `FORGE_EVENT_PG_POOL_MAX`, and `FORGE_WEBHOOK_GOVERNANCE_REQUIRED`. Keep governance required in production.
