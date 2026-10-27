# Secure Artifact Access and Delivery Gateway

Forge Studio artifact bytes are exposed only through the canonical artifact identity (`artifactId`). Callers never provide storage keys, filesystem paths, S3 bucket URLs, or provider-specific object identifiers.

## API

- `GET /v1/artifacts/{artifactId}` — authorized, non-sensitive artifact metadata.
- `POST /v1/artifacts/{artifactId}/access-token?action=download|stream` — issue a short-lived HMAC-signed access token after normal project/provenance/gate authorization.
- `GET /v1/artifacts/{artifactId}/content` — bounded delivery. Supports `Range: bytes=start-end` and signed `access_token` query parameters.

Content delivery uses a provider-independent storage interface. Responses set a safe server-derived filename, trusted content type, content length, strong SHA-256 ETag, `Accept-Ranges`, and private cache semantics. Internal storage URIs, keys, metadata, credentials, and local paths are never returned.

## Authorization policy

1. The artifact must belong to the requested episode/project.
2. The actor must be the project owner or a server-stored project member/actor declared in project access metadata. Artifact administrators and configured worker identities are explicit server-side policies, not client-supplied roles.
3. The artifact lifecycle ledger must not be `QUARANTINED`, `DELETION_PENDING`, or `DELETED`, and storage must be `READY`, unless an explicit administrator recovery policy is used.
4. The artifact version must be reachable from the episode's current-version/provenance graph or current/approved render roots.
5. User downloads/streams require the episode to be `APPROVED`, `PUBLISHING`, or `PUBLISHED` and the artifact to be the approved render. Worker delivery is allowed only for configured worker actors with `purpose=worker`.
6. Recovery access is administrator-only and is always auditable.

An artifact that is no longer reachable from a delivery root is treated as superseded for delivery purposes, even though immutable provenance records remain retained.

## Security controls

- Artifact identifiers are strictly validated; storage keys are never accepted from HTTP callers.
- Local storage rejects traversal outside its configured root.
- S3 access uses server-derived content-addressed keys and provider SDK calls only.
- Full downloads verify SHA-256 and trusted content length. Range reads are bounded and verify the exact requested byte count against the trusted object size.
- Multiple ranges and oversized ranges are rejected.
- Access tokens use HMAC-SHA-256, actor/artifact/action binding, `nbf`, and short expiration. Tampering or expiration is denied before storage access.
- Quarantined, deleted, deletion-pending, superseded, missing, and corrupt artifacts are denied by default.
- Audit events record access decisions and transfer sizes without raw content or storage credentials.
- Client cache is private and short-lived; the immutable SHA-256 ETag is safe for conditional requests.

## Configuration

Required for signed access tokens:

- `FORGE_ARTIFACT_ACCESS_SECRET` — at least 32 bytes of high-entropy secret material.
- `FORGE_ARTIFACT_TOKEN_TTL_SECONDS` — default 300 seconds; bounded to 30–3600 seconds.
- `FORGE_ARTIFACT_MAX_RANGE_BYTES` — default 16 MiB.
- `FORGE_ARTIFACT_MAX_TRANSFER_BYTES` — default 1 GiB.
- `FORGE_ARTIFACT_ADMIN_ACTORS` — comma-separated server-side recovery administrators.
- `FORGE_ARTIFACT_WORKER_ACTORS` — comma-separated server-side worker identities allowed to consume pre-approval artifacts.

Storage remains configured through the existing `FORGE_STORAGE_DRIVER`, `FORGE_STORAGE_LOCAL_ROOT`, and S3 environment variables.

## Operational runbook

### Missing/corrupt delivery

The gateway maps provider failures to safe public errors and marks missing/corrupt storage metadata for reconciliation. Do not expose the provider error or object URI to callers. Re-run the existing reconciliation workflow after correcting the backend.

### Quarantine/recovery

Set lifecycle state through the existing controlled lifecycle/reconciliation path. Never bypass the gateway by handing a storage key to a caller. Administrators may use an explicit recovery policy for incident response; every recovery access creates an audit event.

### Key rotation

Rotate `FORGE_ARTIFACT_ACCESS_SECRET` as an operational deployment change. Existing signed URLs expire naturally; a rotation immediately invalidates all outstanding tokens because signatures are secret-bound.

### Monitoring

Watch `/internal/artifact-gateway/healthz`, `/internal/artifact-gateway/metrics`, HTTP 401/403/404/416/503 responses for artifact routes, storage `MISSING`/`CORRUPT` states, and artifact access audit events. Repeated denial spikes can indicate IDOR probing or malformed-token attacks. Never log raw artifact content, signed URLs, access tokens, storage keys, or provider URLs.

## Canonical consumer rule

Render, publishing, Shorts handoff, QA, and other episode consumers should pass `artifactId` plus episode/version context into the artifact service. They must not reconstruct storage keys or read `storage_uri` directly. Storage-provider changes therefore remain isolated behind the artifact storage abstraction and gateway.
