# Provider Contract Verification

Forge Studio treats provider compatibility as runtime admission control, not a registry hint.

## Contract model

Each provider/capability has immutable, signed versions in `forge_provider_contracts`. A contract describes supported operations and models, input/output schemas, media formats and limits, latency/timeouts, idempotency, regions, credential requirements, and provider/API version metadata with an optional `validUntil` freshness bound.

The body is canonicalized, SHA-256 hashed, and signed with `FORGE_PROVIDER_CONTRACT_SIGNING_SECRET`. Secrets and raw provider payloads are never written to decision evidence.

## Runtime admission

For tenant-scoped execution, `ProviderRegistry.execute()` deterministically negotiates a compatible signed contract across the primary provider and existing fallbacks before `ProviderHealthRouter` runs. Candidates are rejected when contracts are missing, stale, invalidly signed, quarantined, outside the requested region, incompatible with operation/model, or incompatible with active credentials. If no candidate remains, execution fails closed with `CONTRACT_INCOMPATIBLE` and signed decision evidence is persisted.

The health router only receives negotiated candidates, so normal health/failover remains the compatibility fallback without bypassing the contract boundary. Output validation runs against the negotiated contract; schema/limit drift quarantines the provider/capability and blocks further use until an operator clears quarantine.

Generation workers install the contract service against their real PostgreSQL pool. The contract bootstrap is loaded with the existing credentials bootstrap for API and startup enforcement.

## Operations

Set `FORGE_PROVIDER_CONTRACT_SIGNING_SECRET` in every API/worker process performing tenant-scoped provider execution. Startup verifies every ACTIVE contract. Tampered or unsupported active contracts cause a non-zero process exit code rather than unverified execution.

Operator endpoints:

- `GET /internal/providers/contracts?provider=&capability=` — contract metadata only.
- `GET /internal/providers/contracts/state?provider=&capability=` — quarantine state.
- `POST /internal/providers/contracts` — install/activate a signed contract version; operator/admin only.
- `POST /internal/providers/contracts/quarantine/clear` — clear quarantine after remediation; operator/admin only.

The existing HTTP authentication layer protects these endpoints. Decision evidence is immutable and signed; database triggers reject edits/deletes and sensitive-looking evidence fields.

## Provider API drift / incident response

1. Do not disable contract verification to work around provider errors.
2. Inspect contract state and decision evidence for the provider/capability.
3. If schemas, media formats, models, API versions, or credentials changed, publish a new contract version instead of mutating an old version.
4. Keep the old version retired/quarantined until adapter/provider behavior is verified.
5. Clear quarantine only after a live compatibility and credential check succeeds.
6. Re-run contract regression tests and migration preflight before deployment.

## Failure and retry semantics

Contract failures are non-retryable compatibility failures. Provider health failures remain eligible for existing retry/failover policy, but a provider is never retried through an incompatible contract. Concurrent quarantine is observed by the next negotiation, preventing a health race from re-admitting the provider. Decisions are deterministic for the same tenant/run/capability/operation/model/candidate set.

## Configuration

```text
FORGE_PROVIDER_CONTRACT_SIGNING_SECRET=<strong-random-secret>
```

Do not commit live credentials or provider payloads. Register provider-specific contract versions through the control-plane API or a release migration containing only public capability metadata.
