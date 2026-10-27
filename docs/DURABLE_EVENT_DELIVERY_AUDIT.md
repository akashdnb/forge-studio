# Durable Delivery Integration Audit

- Existing `forge_outbox` remains the transactional handoff; delivery state is separate so provider job durability is not overloaded.
- Episode/workflow state is captured after the source mutation inside the same transaction; delivery cannot mutate workflow state.
- Provider callbacks/GitHub Actions and publish state are represented as metadata-only events downstream of their existing authorization and gates.
- Security audit inserts are captured without raw request content or credentials.
- Tenant/RBAC checks reuse the existing authentication primitives; database guards prevent cross-tenant project/event/delivery ownership.
- Artifact gateways remain separate; event payloads never embed raw artifacts or access tokens.
- Existing usage/budget enforcement remains authoritative because notification delivery does not start provider execution.
- Existing webhook replay infrastructure is complemented by deterministic outbound delivery IDs, timestamped HMAC, and receiver idempotency guidance.
- Metrics/attempt tables provide backlog, DLQ, latency, response classification, and failure diagnostics without sensitive payload logging.

The subsystem is deliberately downstream of committed production state, so a webhook outage/retry/replay cannot bypass approval, QA, provenance, publish, or provider-budget controls.
