# Inbound Event Intake, Quarantine and Replay Runbook

## Invariants
- Existing signed `forge_inbound_events` acceptance and durable job creation remain the execution boundary.
- `forge_event_intake` records tenant/project scope, source/provider identity, schema/version, timestamps, signature/nonce state, correlation/causation IDs, payload hash, deduplication key, processing state, attempts, quarantine reason and retention.
- Identity fields are database-immutable; raw bodies, secrets and authorization material are not stored.
- External event identity is unique per endpoint; payload digest differences remain conflicts in the existing ingress service.
- Replay is OWNER-only and tenant-scoped. PostgreSQL replay epochs prevent concurrent operator replays for the same event/route.

## Ingress safety
1. Resolve the endpoint to a tenant/project before acceptance.
2. Bound raw bytes before JSON parsing.
3. Verify the canonical HMAC over the exact raw body.
4. Enforce timestamp/replay-window and nonce checks.
5. Validate event schema/version before downstream execution.
6. Preserve the existing atomic event/job transaction so an accepted event cannot be committed without a durable processing job.

## Quarantine and replay
Permanent validation failures remain rejected; downstream poison events are mirrored as `QUARANTINED` from the existing DLQ path. Retryable provider/network failures remain under the durable job retry budget. Operators replay through the authenticated intake replay endpoint, which claims the event, enqueues a new idempotent job, and releases the claim on completion or failure.

## Ordering and gaps
If a provider payload exposes a monotonic sequence plus stream key, the hardening layer maintains `forge_event_order_watermarks` and records forward gaps. Events without an explicit ordering contract are not assigned an artificial order.

## Retention and monitoring
`FORGE_INBOUND_RETENTION_DAYS` defaults to 90 days. Deletion must continue to honor the existing evidence/legal-hold retention policy. Monitor rejection/duplicate rates, pending lag, quarantine growth, ordering gaps and stale replay claims through tenant-scoped intake metrics.

## Failure injection checklist
Test disposable PostgreSQL scenarios for crash-after-intake, duplicate concurrent delivery, stale signatures/clock skew, nonce reuse, conflicting identities, malformed/oversized payloads, provider retry storms/failover, worker lease expiry, concurrent operator replay, schema evolution, and retention/legal-hold deletion.
