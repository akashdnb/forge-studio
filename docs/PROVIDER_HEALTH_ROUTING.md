# Provider health, circuit breaking, failover and adaptive routing

Forge already has bounded provider retries/circuits. This subsystem adds the durable routing plane: health is scoped by tenant/project/provider/model/operation, health observations are idempotent, and routing decisions are persisted with credential-version and release-epoch fencing.

## Routing contract

A provider candidate is eligible only when all declared constraints match: tenant/project scope, capability/model/operation, credential version, release epoch, capacity admission and budget admission. A caller can also supply a credential-fence callback for the credential registry's current version.

An unscoped candidate is not treated as a cross-tenant fallback. Shared providers must be explicitly marked `global`; tenant/project-scoped candidates must declare their scope.

## Circuit state

`CLOSED` admits normal traffic. `OPEN` rejects traffic until the PostgreSQL cooldown expires. Exactly one worker can claim a `HALF_OPEN` probe through a conditional update. Probe leases expire, so a crashed worker cannot permanently quarantine a provider. Circuit transitions use PostgreSQL time rather than worker clocks.

Only transient failures, timeouts and rate limits contribute to provider health. Authentication, malformed output, provenance, approval, security and budget errors remain terminal and do not trigger unsafe failover.

## Adaptive routing

Eligible providers are ranked deterministically from explicit priority, rolling-window success rate and latency EWMA. Provider name is the final tie-breaker. Routing never substitutes a provider that fails the request's declared capability/model/operation/scope/fencing contract.

## Failover

Failover is enabled only for an idempotent operation with `allowFailover=true`. A retryable provider outage is recorded before the next candidate is selected. The failed provider is excluded from subsequent route attempts for that execution, preventing a scheduler race from immediately selecting the same degraded provider.

## Idempotency and duplicate callbacks

Health event identities are deterministic from the durable idempotency key, provider, operation, attempt and outcome. PostgreSQL `ON CONFLICT` makes duplicate callbacks converge. Routing decision identities include release epoch and credential version, so stale workers cannot silently replace a newer route decision.

## Diagnostics and metrics

`ProviderHealthRouter.diagnostics()` returns health metadata only; credentials and provider payloads are never returned. Metrics include `forge_provider_health_events_total` and `forge_provider_health_latency_ms`. Existing provider reliability metrics remain authoritative for attempt/retry/circuit telemetry.

## Outage runbook

1. Inspect provider/model/operation circuit state for the affected tenant/project.
2. Verify the rolling failure window and latency EWMA.
3. Check credential version and release epoch fencing before changing provider order.
4. Confirm capacity and budget admission before enabling a fallback.
5. Allow the bounded half-open probe to recover the provider; do not manually bypass the circuit from a worker.
6. Reconcile stale worker/lease state before replaying durable jobs.
