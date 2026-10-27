# Durable Event, Webhook, and Notification Delivery

Forge Studio now has a durable event delivery vertical slice backed by PostgreSQL.

## Guarantees

- Source-state events are captured by PostgreSQL triggers in the same transaction as the source mutation. The trigger writes an immutable `forge_events` row and a `forge_outbox` row before the source transaction can commit.
- Events have immutable IDs, monotonically increasing sequence numbers, explicit schema versions, tenant/project ownership, and provenance metadata.
- The outbox fanout step materializes one deterministic delivery ID per event/subscription pair. Duplicate fanout or worker crashes therefore cannot create a second logical delivery.
- Subscriptions are tenant-scoped and can optionally be restricted to a project and event type list. The API uses the existing signed-token/RBAC model.
- Webhooks are signed with HMAC-SHA256 over `timestamp.rawBody`; the timestamp is sent in `X-Forge-Timestamp` and the signature in `X-Forge-Signature: v1=<hex>`.
- `X-Forge-Delivery-Id` is stable across retries. Receivers must persist it and return success for an already-processed ID to make redelivery externally idempotent.
- Delivery leases are fenced by a random lease token and expire automatically. A later worker can recover an abandoned `IN_FLIGHT` delivery.
- Ordered subscriptions do not claim a later sequence until every earlier delivery for that destination is terminal (`SUCCEEDED`, `CANCELLED`, or `DEAD_LETTER`).
- Per-destination concurrency and one-second rate limits are enforced during claim. `Retry-After` is honored for retryable responses.
- HTTP 2xx succeeds; 408/409/425/429 and 5xx are retried; other 4xx responses are terminal failures. Network/DNS/timeout errors are retryable.
- Retries use bounded exponential backoff with jitter. The default maximum is eight attempts. Exhausted deliveries enter the dead-letter/quarantine table.
- Secrets are stored encrypted with AES-256-GCM. The plaintext secret is never returned by the API and is never logged.
- Payloads intentionally contain IDs, state, status, and provenance-safe metadata rather than raw artifact contents, provider credentials, or request secrets.
- Delivery metrics expose backlog, status counts, and DLQ depth. Attempt rows preserve latency, response status, and sanitized error code information.

## Event types

| Event | Version | Source |
| --- | ---: | --- |
| `episode.state.changed` | 1 | episode state transition |
| `job.state.changed` | 1 | durable job state transition |
| `provider_run.state.changed` | 1 | provider run transition |
| `publish.state.changed` | 1 | publishing state transition |
| `approval.created` | 1 | approval creation |
| `qa.result.recorded` | 1 | QA result creation |
| `security.audit.recorded` | 1 | security audit event creation |

Adding a new event type requires adding a schema entry, a migration/source capture path, and tests. Never mutate the meaning of an existing version; add version 2 when the contract is incompatible.

## API

The standalone event API is `src/events/server.js` and exposes:

- `GET /healthz`
- `GET /v1/event-schemas`
- `GET /v1/event-subscriptions?projectId=...`
- `POST /v1/event-subscriptions`
- `PATCH /v1/event-subscriptions/:id`
- `DELETE /v1/event-subscriptions/:id`
- `GET /v1/event-deliveries`
- `POST /v1/event-deliveries/:id/cancel`
- `POST /v1/event-deliveries/:id/replay`
- `GET /v1/event-delivery/metrics`

The service authenticates with the same `FORGE_AUTH_SIGNING_SECRET`/`API_BEARER_TOKEN` model as the main API. Owner role is required for subscription mutation, cancellation, and replay.

## Worker registration

Run `node src/events/delivery-worker.js` as a durable worker against the same PostgreSQL database. It performs outbox fanout, delivery claiming, HTTP delivery, lease recovery, retries, and DLQ quarantine.

For Render, register a worker using the existing Forge Docker image with:

```text
node src/events/delivery-worker.js
```

Required configuration:

```text
DATABASE_URL=<postgres connection string>
FORGE_EVENT_SECRET_KEY=<stable secret used to encrypt webhook secrets>
FORGE_EVENT_POLL_MS=1000
FORGE_EVENT_FANOUT_BATCH=100
FORGE_EVENT_DELIVERY_BATCH=10
FORGE_EVENT_RECOVERY_EVERY=10
FORGE_EVENT_PG_POOL_MAX=5
```

The event API uses `FORGE_EVENT_PORT` (default `8090`) and the same database/auth environment variables.

## Receiver verification

1. Read the raw request body without parsing/re-serializing it.
2. Reject timestamps outside the five-minute replay window.
3. Compute HMAC-SHA256 over `${timestamp}.${rawBody}` with the subscription secret.
4. Compare the signature with a constant-time comparison.
5. Persist `X-Forge-Delivery-Id` before performing an external side effect; if it was already processed, return a 2xx response without repeating the side effect.
6. Keep processing idempotent even when the sender times out after the receiver has committed the side effect.

`verifyWebhookSignature()` is exported from `src/events/durable-delivery.js` for receiver tests and SDK integrations.

## Cancellation, replay, and secret rotation

Disabling a subscription prevents new claims and cancels queued/retry deliveries. In-flight requests are allowed to finish under their lease.

Replay resets the existing deterministic delivery to `RETRY`; it does not create a second delivery identity. Receivers therefore see the same delivery ID and must treat it as an idempotent redelivery.

Secrets are encrypted at rest. Rotate by creating a new subscription secret, validating delivery, then disabling the old subscription. A future key-version column can be added without changing the event/delivery identity model.

## Budget and production gates

Event delivery is notification work rather than a provider generation operation, so it does not consume provider usage reservations. It never starts provider work and never changes episode state. Events are captured only from already-committed/triggered source mutations, so delivery cannot bypass approval, QA, provenance, publish gates, or provider budget enforcement. A failed notification cannot roll back or advance production state.

## Operations

- Rising `RETRY` backlog: inspect endpoint latency, 429/5xx rates, and subscription concurrency/rate limits.
- `DEAD_LETTER` growth: inspect `forge_event_dlq` and `forge_event_delivery_attempts`; fix the receiver before replaying.
- Lease churn: inspect worker restarts, database latency, and `FORGE_EVENT_DELIVERY_BATCH`.
- Signature failures: verify the receiver uses the raw body and current subscription secret.
- Cross-tenant concerns: all subscription, delivery, and metrics queries are tenant-filtered and event rows are database-guarded against project/tenant mismatch.

Never log webhook bodies, encrypted secrets, authorization headers, signed URLs, provider credentials, or raw artifact content.
