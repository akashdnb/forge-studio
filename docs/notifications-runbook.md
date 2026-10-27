# Notification and Channel Delivery Runbook

## Architecture

Notification requests are durable PostgreSQL intents. Producer transitions (workflow jobs, approvals, incidents, publishing, and provider circuit/brownout state) write `notification.requested` rows into the existing transactional `forge_outbox` in the same database transaction. The notification runtime materializes those rows into immutable intent/recipient/delivery state, then leases deliveries with PostgreSQL `FOR UPDATE SKIP LOCKED` fencing.

The runtime is started by `src/runtime/worker-entry.js`; API routes are installed by `src/notifications/http-bootstrap.js`.

## Channels

- `webhook` is implemented directly with HTTPS, request timeout, idempotency key, retry classification, and the existing provider circuit breaker.
- `email`, `push`, `sms`, and `voice` route through the existing `ProviderRegistry` only when a provider is registered for `notification.<channel>`. A missing adapter is quarantined as `CHANNEL_UNAVAILABLE`; the subsystem never silently pretends an unsupported channel was sent.

## Routing

Recipient preferences are ordered by `rank` and resolved deterministically. The first channel is attempted first; a terminal failure activates the next queued channel. Once one channel succeeds, remaining channels for that recipient are cancelled. Dedupe is enforced by tenant + delivery dedupe key and provider request key.

## Reliability

- Delivery leases are 90 seconds and fenced by a monotonically increasing `fencing_token`.
- Expired leases are returned to `RETRY` by the runtime.
- 429/5xx/timeouts/network/circuit-open failures retry with exponential backoff plus jitter; `Retry-After` is honored when present.
- Exhausted or non-retryable deliveries become `DEAD_LETTER` or `QUARANTINED`.
- Deadlines, cancellation, suppression, tenant entitlement budgets, distributed rate limits, and durable provider circuit state are checked before send.
- Webhook requests carry a stable idempotency key so a worker crash after the remote provider accepts a request can be reconciled without generating a new user-visible identity.

## Quiet hours and DST

Quiet hours are evaluated in the recipient IANA timezone using `Intl.DateTimeFormat`, not by adding a fixed wall-clock offset. The scheduler walks UTC instants through the local-time window, so DST transitions do not shift the configured local quiet-hour boundary.

## Operator APIs

- `POST /v1/notifications`
- `GET /v1/notifications`
- `GET /v1/notifications/:id`
- `POST /v1/notifications/:id/cancel`
- `POST /v1/notification-suppressions`
- `GET /v1/notifications/health`

All operator calls require a tenant scope (`x-tenant-id`) and are recorded in notification audit evidence for mutating actions.

## Incident response

### Queue backlog

Inspect `forge_notification_deliveries` by status and `next_attempt_at`. If leases are stuck, the runtime's recovery pass will return expired leases to `RETRY`.

### Provider outage

Inspect `provider_circuit_breaker_state` and `provider_circuit_breaker_events`. Do not manually reset provider state unless the provider incident is understood. The notification router respects the same durable circuit/brownout admission used by provider execution.

### Quarantine / dead letter

Inspect `forge_notification_deliveries.status`, `quarantine_reason`, and `forge_notification_attempts`. Correct recipient/provider configuration before replaying. Replay by creating a new notification intent version with a new dedupe key; do not mutate historical attempts.

### Suppression

Use `POST /v1/notification-suppressions` for planned maintenance or recipient-level suppression. Keep the reason and expiry explicit. Remove/expire the suppression after the incident.

## Metrics

The runtime emits `forge_notification_deliveries_total` with `channel` and `outcome` labels. Combine this with existing provider circuit, rate-limit, entitlement, worker queue, and incident metrics for dashboards and alerts.

## Migration

Run the normal migration command (`npm run migrate`) before starting workers on a release containing migration `161_notification_delivery_orchestration.sql`. The migration is idempotent and creates producer triggers after all referenced primitives exist.
