# Provider reliability

Forge routes provider-backed work through bounded reliability policies: per-provider/operation timeouts, retry classification, exponential backoff with jitter, `Retry-After`, circuit breaking, local concurrency/rate limiting, cancellation/deadline propagation, deterministic attempt identities, normalized errors, health probes and contract-gated failover.

## Safety contract

Retries are limited to transient transport/provider failures. Authentication/configuration, malformed output, provenance/approval/security failures, budget exhaustion and cancellation remain terminal. Failover is allowed only when the operation is idempotent and the fallback is explicitly contract-compatible.

Every attempt receives a deterministic `attemptId` derived from the durable idempotency key, provider, operation and attempt number. Existing immutable artifact/version identities, usage reservations, approval gates and worker fencing remain authoritative.

## Configuration

For each HTTP workflow stage, the base endpoint is `FORGE_STAGE_<STAGE>_ENDPOINT`. Reliability settings include:

```text
FORGE_STAGE_SCRIPT_TIMEOUT_MS=120000
FORGE_STAGE_SCRIPT_MAX_ATTEMPTS=3
FORGE_STAGE_SCRIPT_RETRY_BASE_MS=250
FORGE_STAGE_SCRIPT_RETRY_MAX_MS=10000
FORGE_STAGE_SCRIPT_CIRCUIT_FAILURE_THRESHOLD=5
FORGE_STAGE_SCRIPT_CIRCUIT_RECOVERY_MS=30000
FORGE_STAGE_SCRIPT_MAX_CONCURRENCY=8
FORGE_STAGE_SCRIPT_RATE_LIMIT_PER_SECOND=0
```

`FORGE_STAGE_<STAGE>_FALLBACK_ENDPOINT` is accepted only with `FORGE_STAGE_<STAGE>_FALLBACK_COMPATIBLE=true`; the fallback must implement the `forge-stage-v1` contract. Generation/TTS providers use the same engine through `ProviderRegistry`.

## Circuit and quarantine semantics

With PostgreSQL configured, circuit state is persisted in `provider_circuit_states`, so workers share OPEN/HALF_OPEN/CLOSED recovery state. OPEN is the provider quarantine state; HALF_OPEN admits only a bounded recovery probe. Test/local operation uses an in-process circuit.

Reliability decisions are persisted to `provider_reliability_events` without request bodies or secrets. `ProviderReliability.diagnostics()` exposes circuit state plus in-process counters/gauges for operational tooling.

## Retry classification

Retryable: HTTP 408/425/429 and bounded 5xx responses, connection reset/refused, retryable DNS failures and provider timeouts. `Retry-After` is honored and capped at five minutes.

Terminal: 400/401/403/404/405/409/422, missing credentials/configuration, malformed output, approval/provenance/security/budget/cancellation failures.

## Metrics

The engine emits `forge_provider_attempts_total`, `forge_provider_success_total`, `forge_provider_errors_total`, `forge_provider_retries_total`, `forge_provider_failover_total`, `forge_provider_circuit_open_total`, `forge_provider_latency_ms`, `forge_provider_health_probe_success_total` and `forge_provider_health_probe_failure_total`.

## Side-effecting paths

YouTube publishing and GitHub Actions execution are intentionally not wrapped in blind generic retries. Their existing resumable sessions, durable leases, callback fencing and reconciliation are the safety boundary for externally visible side effects. The reliability layer can be applied to a side-effecting adapter only when its adapter contract explicitly proves idempotent/reconcilable behavior.

## Incident runbook

1. Inspect provider circuit state and recent reliability events.
2. Classify the failure as transient, rate-limited, authentication/configuration, contract, or provenance/security.
3. For OPEN circuits, verify upstream health and allow the bounded HALF_OPEN probe to recover normally.
4. For rate limits, check `Retry-After`, provider quota and local concurrency/rate settings.
5. For failover, verify explicit contract compatibility and idempotency before enabling the fallback.
6. For billing concerns, inspect the durable provider-run idempotency key and attempt IDs; never manually replay a side-effecting publish job.
