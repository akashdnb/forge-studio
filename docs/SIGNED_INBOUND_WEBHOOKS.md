# Signed External Webhooks and Event Ingestion

Forge exposes tenant-owned inbound webhook identities at `POST /webhooks/:endpointId/events`.

## Contract

Headers:

- `X-Forge-Event-Id`: stable external event identity, unique per endpoint.
- `X-Forge-Event-Type`: `provider.callback`, `runner.callback`, `workflow.transition`, or `reconciliation.request`.
- `X-Forge-Event-Version`: currently `1`.
- `X-Forge-Timestamp`: Unix seconds.
- `X-Forge-Nonce`: unique request nonce.
- `X-Forge-Signature`: `v1=<hex HMAC-SHA256>`.

Canonical bytes are:

```text
METHOD\nPATH\nENDPOINT_ID\nTIMESTAMP\nNONCE\nSHA256(RAW_BODY)
```

The signature is HMAC-SHA256 with the active endpoint secret. Raw request bytes are authenticated before JSON normalization. Bodies are bounded and must use `application/json`.

## Lifecycle

1. Authenticate signature against the active key or an explicitly bounded rotation grace key.
2. Reject stale timestamps, malformed nonces, invalid signatures, unsupported schemas and oversized bodies.
3. Detect `(endpoint,eventId)` duplicates by deterministic payload digest. Same identity + same digest is an idempotent acknowledgement; same identity + different digest is a hard conflict.
4. Persist only the raw SHA-256 digest plus a normalized envelope; secrets and raw request bodies are never stored.
5. Persist the durable Forge job and inbound effect row in the same PostgreSQL transaction as the event. A crash cannot produce a persisted event without its processing job.
6. Workers claim normal Forge jobs with the existing lease/retry/concurrency controls. Inbound handlers transactionally apply the logical effect and mark the effect complete in the same transaction.
7. Permanent failures are terminal and visible through the inbound DLQ; operators can replay quarantined work using the authenticated replay endpoint.

## Secret rotation

`POST /v1/inbound-webhook-endpoints/:id/rotate-secret` is OWNER-only. Forge returns the new secret exactly once. The previous key is disabled for new configuration but remains valid only for the requested bounded grace period. Rotation is recorded in the webhook audit table.

## Operations

- `GET /healthz` — service/database health.
- `GET /v1/inbound-webhook/metrics` — tenant-scoped event/effect/DLQ counts.
- `GET /v1/inbound-events` — digest-only event diagnostics.
- `GET /v1/inbound-events/:id/attempts` — processing state and sanitized errors.
- `POST /v1/inbound-events/:id/replay` — OWNER-only replay through the durable job queue.

Never log or paste webhook secrets, Authorization headers, signatures, raw payloads, or provider tokens into incident tickets. Payload digests and event IDs are safe correlation identifiers.

## Failure policy

Bad signatures, expired timestamps, replayed nonces, tenant mismatches, malformed JSON, unknown event types, invalid versions, and conflicting event identities fail closed. Provider/network failures remain inside the durable job retry budget. Do not manually mutate provider/workflow state to recover an inbound event; use operator replay after fixing the downstream cause.

## Security review checklist

- Verify the endpoint is project-scoped unless a deliberately tenant-wide integration is required.
- Confirm the external sender signs exact raw bytes and uses a fresh nonce for every request.
- Rotate secrets after suspected compromise and keep the grace window as short as practical.
- Alert on sustained signature failures, conflicting identities, retry backlog and DLQ growth.
- Validate the tenant/project relationship before applying provider, runner or workflow effects.
