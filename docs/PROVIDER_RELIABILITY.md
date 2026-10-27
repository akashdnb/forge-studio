# Provider reliability

Forge routes provider-backed work through a bounded reliability policy. The layer applies per-provider/operation timeouts, retry classification, exponential backoff with jitter, `Retry-After`, circuit breaking, local concurrency/rate limiting, cancellation/deadline propagation, deterministic attempt identities, normalized errors and contract-gated failover.

## Safety contract

Retries are permitted only for transient transport/provider failures. Authentication/configuration errors, malformed responses, provenance/approval failures, budget exhaustion and cancellation are terminal. A failover is permitted only when the operation is explicitly idempotent and the fallback is declared contract-compatible.

Every attempt receives a deterministic `attemptId` derived from the durable idempotency key, provider, operation and attempt number. Provider outputs must still use Forge's existing immutable artifact/version identity rules. Reliability never bypasses approval, provenance, authorization, QA or budget gates.

## Per-stage configuration

For each HTTP workflow stage, the base endpoint remains `FORGE_STAGE_<STAGE>_ENDPOINT`. Optional reliability settings are:

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

`FORGE_STAGE_<STAGE>_FALLBACK_ENDPOINT` is accepted only when `FORGE_STAGE_<STAGE>_FALLBACK_COMPATIBLE=true`. A fallback must implement the exact `forge-stage-v1` contract and produce the same logical artifact contract. It is never used for an approval/provenance/security/budget error.

Generation and TTS providers use the same reliability engine through `ProviderRegistry`. Provider-specific policies can be supplied when constructing `ProviderReliability` with keys such as `provider` or `provider:operation`.

## Circuit semantics

Circuit state is persisted in PostgreSQL (`provider_circuit_states`) when a pool is supplied, so multiple workers converge on the same OPEN/HALF_OPEN/CLOSED state. The half-open state allows a bounded probe before recovery. Local-only/test use falls back to an in-process circuit.

Provider reliability events are designed for structured diagnostics without secrets. Do not log request bodies, API keys, access tokens, provider response bodies or signed callback payloads.

## Retry classification

Retryable:

- HTTP 408/425/429 and bounded 5xx responses.
- Connection reset/refused, DNS retryable failures and provider timeouts.
- Provider-declared transient errors.
- `Retry-After` is honored and capped at five minutes.

Not retryable:

- 400/401/403/404/405/409/422 contract failures.
- Invalid credentials or missing provider configuration.
- Malformed provider responses or invalid output.
- Approval/provenance/security/budget/cancellation failures.

## Operational diagnostics

`ProviderReliability.diagnostics()` returns circuit state plus in-process counters/gauges. Important metrics include:

- `forge_provider_attempts_total`
- `forge_provider_success_total`
- `forge_provider_errors_total`
- `forge_provider_retries_total`
- `forge_provider_failover_total`
- `forge_provider_circuit_open_total`
- `forge_provider_latency_ms`
- `forge_provider_health_probe_success_total`
- `forge_provider_health_probe_failure_total`

Persisted circuit rows and reliability events can be inspected directly in PostgreSQL. Secrets are intentionally absent from both structures.

## Incident runbook

1. Check provider circuit state and recent reliability events.
2. Confirm whether the error is transient, quota/rate-limit, authentication, contract, or provenance-related.
3. For OPEN circuits, verify the upstream outage before forcing traffic; normal recovery is through the bounded half-open probe.
4. For rate limiting, confirm `Retry-After`, provider quotas and local concurrency/rate limits.
5. For failover, verify the fallback contract compatibility flag and confirm that both providers produce the same immutable output contract.
6. For duplicate billing concerns, inspect the durable provider-run idempotency key and attempt identities. Never manually replay a side-effecting publish operation.
7. For stale workers/callbacks, rely on the existing durable lease/callback fencing; provider reliability does not override those gates.

## Testing

The reliability suite covers classification, backoff/jitter, timeout/cancellation, circuit transitions, concurrency/rate limiting, deterministic attempt IDs, idempotent failover and malformed responses. Run:

```bash
npm test -- test/provider-reliability.test.js
npm run check
```
