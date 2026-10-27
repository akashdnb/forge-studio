# Provider credential lifecycle

Forge Studio stores provider credentials as encrypted, tenant/project-scoped credential versions. PostgreSQL contains ciphertext, nonce, authentication tag and key id only; plaintext is decrypted only in process memory immediately before provider execution.

## Scope and capability model

A credential is identified by tenant, optional project, provider, credential name and immutable version. Capability declarations are explicit and checked against the provider capability registry before a lease is issued. A request fails closed on missing, expired, revoked or capability-incompatible credentials.

Typical capability declarations include `text-generation`, `image-generation`, `video-generation`, `tts`, `transcription`, `youtube-upload` and provider/model-specific variants. Operators should register exact provider/model combinations rather than relying on provider-name inference.

## Rotation

Rotation is transactional. The new version becomes `ACTIVE` and the previous version enters bounded `OVERLAP`. New leases always select the newest active version. Existing leases retain their credential version until they are released or expire. Expired overlap versions are retired by the selection transaction and by lease reconciliation.

Rotation requires an explicit confirmation token derived from the current credential id/version. This prevents a stale operator page from rotating a credential that has already changed. Idempotency keys make duplicate operator requests converge.

## Revocation and expiry

Revocation is immediate and does not wait for overlap. New leases fail closed. In-flight requests keep their already-issued lease so an intentional rotation does not interrupt an upload or provider call; operators should revoke only when that behavior is acceptable. Expiry is checked against PostgreSQL time at lease acquisition.

## Release epochs and runner dispatch

Credential leases can carry the current release epoch. A stale epoch is rejected before plaintext is returned. Runner/provider jobs should persist the selected credential version in their execution snapshot and never re-select a credential after dispatch.

## Secret handling rules

Never put credential material into:

- logs or error messages
- provider request/response artifacts
- manifests or provenance payloads
- job payloads or runtime snapshots
- exports, backups or diagnostics
- Prometheus labels

The operator APIs never return plaintext. Audit records contain only credential id, provider, version, capability and redacted diagnostics.

## Operator controls

The authenticated OWNER control plane exposes:

- `GET /internal/providers/credentials?tenantId=...` — metadata only.
- `POST /internal/providers/credentials` — create an encrypted version.
- `POST /internal/providers/credentials/:id/rotate` — rotate with bounded overlap.
- `POST /internal/providers/credentials/:id/revoke` — revoke immediately.
- `POST /internal/providers/credentials/:id/retire` — retire after in-flight work is expected to finish.
- `POST /internal/providers/credentials/:id/test` — run a credential capability probe.
- `GET /internal/providers/credentials/capabilities` — provider/model capability registry.

Mutation confirmation is version-specific. Do not reuse a confirmation token after a rotation.

## Failure runbook

### Provider returns authentication failures

1. Inspect credential status/version and provider health without exposing material.
2. Test the current credential through the operator probe.
3. If invalid, rotate to a known-good credential with a short overlap.
4. Re-run the affected job; do not mutate immutable artifacts.
5. Revoke the compromised version immediately if compromise is suspected.

### Rotation appears stuck

Check `forge_provider_credential_leases` for `HELD` leases and expiry. Do not delete lease rows manually. Run the bounded lease reconciliation job/service. A crashed worker leaves a lease that expires; it does not make a retired credential active again.

### Cross-tenant/provider mismatch

A credential lookup requires tenant and project scope. Never accept a provider credential id from one tenant and then resolve it under another tenant. The database query includes tenant/project predicates and the capability check is performed in the same transaction as lease selection.

## Metrics

The subsystem emits:

- `forge_provider_credential_operations_total`
- `forge_provider_credential_rotations_total`
- `forge_provider_credential_leases_total`

Recommended alerts: repeated `CREDENTIAL_UNAVAILABLE`, `CAPABILITY_MISMATCH`, lease expiry growth, and provider authentication failures.

## Configuration

Production workers require `FORGE_SECRET_ENCRYPTION_KEY`. Keep it as a Render secret and rotate the envelope key only through an explicit key-management procedure; changing it without re-encrypting existing rows makes old credentials unreadable.

Apply `migrations/027_provider_credentials.sql` through the release-safe migration runner. Do not create a second plaintext secret store.
