# Durable Event, Webhook, and Notification Delivery

Forge Studio now has a PostgreSQL-backed durable event delivery vertical slice.

## Guarantees

- PostgreSQL triggers capture key production state changes and append an immutable event plus `forge_outbox` row in the same transaction.
- Events are tenant/project scoped, versioned, sequenced, and carry provenance-safe metadata only.
- Fanout creates one deterministic delivery ID per event/subscription pair; duplicate fanout is harmless.
- Subscriptions are tenant/project scoped and protected by the existing signed-token/RBAC model.
- Webhooks use HMAC-SHA256 over `timestamp.rawBody` and stable `X-Forge-Delivery-Id` values across retries.
- Delivery claims use leases, `FOR UPDATE SKIP LOCKED`, per-destination concurrency/rate limits, and ordered-subscription gating.
- 2xx succeeds; 408/409/425/429 and 5xx retry; other 4xx fail terminally. Network/DNS/timeout errors retry. `Retry-After` is honored.
- Retries are bounded with exponential backoff/jitter; exhausted work enters `forge_event_dlq`.
- Secrets are AES-256-GCM encrypted at rest. Logs never include secrets, auth headers, webhook bodies, signed URLs, or raw artifact content.
- Cancellation and replay are tenant/RBAC protected. Replay keeps the same deterministic delivery identity.
- Delivery never starts provider work or changes production state, so it cannot bypass approval/QA/provenance/publish gates or provider budget enforcement.

## Contracts

`episode.state.changed`, `job.state.changed`, `provider_run.state.changed`, `publish.state.changed`, `approval.created`, `qa.result.recorded`, and `security.audit.recorded` are version 1 contracts. Breaking changes require a new version.

## Services

- Event API: `node src/events/server.js`
- Event worker: `node src/events/delivery-worker.js`
- Configuration: `DATABASE_URL`, `FORGE_EVENT_SECRET_KEY`, and the existing `FORGE_AUTH_SIGNING_SECRET`/`API_BEARER_TOKEN` authentication settings. Render registration is included in `render.yaml`.

API endpoints: `/healthz`, `/v1/event-schemas`, `/v1/event-subscriptions`, `/v1/event-deliveries`, `/v1/event-deliveries/:id/cancel`, `/v1/event-deliveries/:id/replay`, and `/v1/event-delivery/metrics`.

## Receiver guidance

Read the raw body, reject timestamps outside five minutes, HMAC `timestamp.rawBody`, compare in constant time, then persist `X-Forge-Delivery-Id` before performing an external side effect. Treat an already-seen delivery ID as a successful idempotent redelivery.

Secret rotation is performed by provisioning a new subscription secret, validating it, and disabling the old subscription. Event identity does not change.

## Operations

Watch delivery backlog/status counts and DLQ depth. Inspect `forge_event_delivery_attempts` for latency, response status, and sanitized errors. Rising 429/5xx or retry backlog indicates endpoint pressure; rising DLQ indicates a receiver contract or availability problem. Expired leases indicate worker/database instability.
