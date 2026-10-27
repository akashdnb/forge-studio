# Secure Artifact Delivery Runbook

## Scope

All protected artifact reads use `ProductionArtifactAccessGateway`. Browser delivery is exposed through `/v1/artifacts/:artifactId/content`; access grants are short-lived, tenant/project/artifact/version/content-hash bound, audience-bound, purpose-bound and range-aware.

The durable grant ledger is PostgreSQL-backed. The internal delivery cache is keyed by tenant + SHA-256 and is never a substitute for authorization. Protected responses use `Cache-Control: private, no-store` so a shared CDN/browser cache cannot preserve authorization after revocation.

## Production configuration

Required for production signing-key rotation:

- `FORGE_SECRET_ENCRYPTION_KEY`: 32-byte root key (base64 or exactly 32 UTF-8 bytes).
- `FORGE_ARTIFACT_TOKEN_TTL_SECONDS`: normally 300; hard maximum 3600.
- `FORGE_ARTIFACT_MAX_RANGE_BYTES`: bounded range size; default 16 MiB.
- `FORGE_ARTIFACT_MAX_TRANSFER_BYTES`: bounded full-transfer size; default 1 GiB.
- `FORGE_ARTIFACT_ACCESS_SECRET`: legacy fallback only when KMS is unavailable; do not expose it to clients or runners.

With `FORGE_SECRET_ENCRYPTION_KEY`, the existing tenant/project-scoped `capability-token` KMS epoch is used. Retiring epochs remain verifiable for already-issued grants; revoked epochs fail closed.

## Grant issuance

`POST /v1/artifacts/:artifactId/access-token` requires normal bearer authorization. Query parameters may constrain `action`, `audience`, `purpose`, `ttlSeconds`, `maxUses`, `maxBytes`, `rangeStart` and `rangeEnd`.

Tokens are bound to the issuing actor, tenant, project, artifact version and immutable content hash. The database stores only the token hash, nonce and authorization evidence.

## Delivery behavior

- Every token request is revalidated against current tenant/project membership, lifecycle/quarantine state, provenance and approval state.
- Artifact replacement or content-hash drift invalidates the old grant.
- Revocation and denylisting are checked before each read, even when the bytes are already in the local delivery cache.
- One-time grants are atomically consumed under a PostgreSQL row lock. Bounded-use grants serialize concurrent consumers and cannot exceed `maxUses`.
- Range requests are returned as HTTP 206 with `Content-Range`; multi-range requests are rejected.
- Storage credentials remain server-side. Clients receive only signed delivery tokens.

## Operator controls

All operator endpoints require tenant-scoped OWNER authorization:

- `GET /internal/artifact-delivery/health`
- `GET /internal/artifact-delivery/metrics`
- `GET /internal/artifact-delivery/grants/:grantId`
- `DELETE /internal/artifact-delivery/grants/:grantId?reason=...`
- `POST /internal/artifact-delivery/deny`
- `POST /internal/artifact-delivery/rotate`
- `POST /internal/artifact-delivery/revoke-key`

Use project-scoped KMS rotation when isolating blast radius. Revoke an epoch only when all grants using that epoch must fail immediately.

## Incident response

### Suspected token leak
1. Revoke the individual grant.
2. If exposure is broad, denylist the artifact or project.
3. If the signing epoch is compromised, revoke the `capability-token` epoch and rotate it.
4. Check authorization evidence by grant ID and request ID.

### Artifact quarantine or corruption
1. Quarantine/delete through the existing artifact lifecycle controls.
2. Existing grants are still rejected by the live artifact authorization checks.
3. Evict affected delivery-cache objects after integrity failures.
4. Re-run artifact integrity verification before restoring delivery.

### CDN/cache incident
Protected artifact responses must not be shared-cacheable. If a proxy is observed serving stale bytes, remove the shared cache rule, purge the affected cache key, and verify `private, no-store` plus `Vary: Authorization, Range, Cookie`.

### PostgreSQL failure
Grant authorization fails closed if the grant ledger cannot be read or consumed. Do not bypass the gateway or expose direct storage URLs while the control plane is unavailable.

## Evidence and diagnostics

`artifact_delivery_authorization_evidence` is append-only and hash-linked per grant. `artifact_delivery_grant_uses` records the reservation outcome and requested range. Audit events continue to record artifact access denials and successful reads.

Useful production checks:

```sql
SELECT status, count(*) FROM artifact_delivery_grants WHERE tenant_id = $1 GROUP BY status;
SELECT event_type, actor, request_id, created_at FROM artifact_delivery_authorization_evidence WHERE grant_id = $1 ORDER BY id;
SELECT outcome, range_start, range_end, bytes_requested, created_at FROM artifact_delivery_grant_uses WHERE grant_id = $1 ORDER BY created_at;
SELECT scope_type, scope_id, reason, created_at FROM artifact_delivery_denylist WHERE tenant_id = $1 ORDER BY created_at DESC;
```

Never log the token itself, storage credentials, provider credentials or KMS root key.
