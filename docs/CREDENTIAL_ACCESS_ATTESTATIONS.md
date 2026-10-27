# Credential Lease, Scoped Secret Usage and Provider Access Attestation

Forge Studio now separates credential administration from credential use. Workers and public runners receive only short-lived signed grant references. The access boundary is the only component that decrypts credential ciphertext and constructs provider authorization headers.

## Production configuration

Required on the worker/API that hosts the boundary:

- `FORGE_SECRET_ENCRYPTION_KEY` — existing credential envelope key.
- `FORGE_CREDENTIAL_GRANT_SIGNING_SECRET` — HMAC key for short-lived grants and attestations.
- `FORGE_REGION` — immutable execution region binding.
- `FORGE_RELEASE_EPOCH` or `FORGE_RELEASE_ID` — execution epoch binding.

Do not put provider secrets in job payloads, runner manifests, workflow metadata, logs, traces, callbacks, artifacts or environment snapshots.

## Lease contract

A lease is bound to tenant/project, purpose, provider/model, workflow/job/attempt, region and execution epoch. The scope is immutable. Leases default to 120 seconds and are bounded to 15 minutes. Grants are shorter lived than the lease. Renewal increments a fencing token; old tokens are rejected. Expired and revoked leases cannot issue or use grants.

Credential rotation is dual-read/single-write: new attempts select the newest `ACTIVE` version, while existing leases can continue using an `OVERLAP` version until release/expiry. Credential revocation immediately fences all active access leases and grants for that credential.

## Provider execution

`workflow:*` HTTP provider stages no longer send `FORGE_STAGE_PROVIDER_TOKEN`. They acquire a provider/model/capability-scoped grant and call the credential access boundary. The boundary decrypts the selected credential only at the outbound HTTP request boundary, redacts all persisted evidence, and writes a signed usage attestation.

Provider failover creates a new provider-scoped lease. A failed primary lease is never reused for the fallback provider. Provider contract/capability state must be current; missing or stale credential state fails closed.

## Public runners

Public-runner manifests may contain only an opaque scoped grant reference. The manifest security layer rejects fields such as `token`, `secret`, `password`, `authorization`, `apiKey`, `material` and `ciphertext`. Grants are short-lived and fenced to the execution epoch, provider, purpose and region. Runner callbacks never receive credential values.

## Operator API

Authenticated OWNER operators can inspect and control:

- `GET /internal/providers/credential-access/leases?tenantId=...`
- `GET /internal/providers/credential-access/history?tenantId=...`
- `POST /internal/providers/credential-access/leases/:id/renew`
- `POST /internal/providers/credential-access/leases/:id/release`
- `POST /internal/providers/credential-access/leases/:id/revoke`
- `POST /internal/providers/credential-access/cleanup`
- `GET /internal/providers/credential-access/health?tenantId=...`

The history endpoint returns credential class/provider/version/scope and signed attestation evidence, never material.

## Crash and recovery runbook

1. If a worker dies, do not manually delete lease rows. Run bounded cleanup; expired leases are fenced by PostgreSQL time.
2. If a worker restarts, the old grant expires and the next attempt acquires a new fencing token.
3. If a runner callback is duplicated, the durable execution/attempt identity remains authoritative; credential attestations are uniqueness-fenced by tenant/job/attempt/operation/outcome.
4. If the release epoch changes, new grants are rejected and public runner executions are fenced by the existing release safety controls.
5. If a credential is compromised, revoke the credential version first. The revocation hook immediately fences active access leases and grants.
6. During rotation, keep overlap bounded. New attempts must use the new version; do not extend an old lease indefinitely.
7. If region state is unavailable or ambiguous, do not issue a grant. Restore the region/epoch configuration and retry the attempt.

## Diagnostics and metrics

Watch:

- `forge_credential_access_leases_total`
- credential unavailable/capability-denied rates
- expired/revoked lease counts
- provider authentication failures
- stale fencing token errors
- public runner manifest expiry/security events

Useful SQL diagnostics are limited to lease state, provider, version, scope hashes, expiry and attestation metadata. Never select or export credential ciphertext for routine diagnostics.
