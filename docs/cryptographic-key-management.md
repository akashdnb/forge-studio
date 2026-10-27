# Cryptographic Key Management Runbook

Forge Studio now uses tenant/project-scoped envelope encryption for durable provider credentials and runtime secrets.

## Design

- Root key: `FORGE_SECRET_ENCRYPTION_KEY`, a 32-byte deployment secret. It is a KEK only; it is never persisted in PostgreSQL.
- Key epochs: `forge_crypto_key_epochs` stores wrapped 32-byte DEKs, one active epoch per tenant/project/purpose.
- Data encryption: AES-256-GCM with authenticated associated data binding tenant, project, purpose and epoch.
- Purposes are separated (`provider-credential`, `runtime-secret`, `webhook-secret`, `capability-token`, `export-secret`, `audit-sensitive`, `artifact-content`, `runner-secret`). A ciphertext cannot be moved across scopes or purposes without authentication failure.
- Immutable history: old key epochs are retained as `RETIRING`/`RETIRED`; immutable audit and historical ciphertext are never rewritten merely because the active epoch changes.

## Migration behavior

The system is dual-read/single-write. Legacy rows without `key_epoch` continue to use the legacy deployment cipher. New credential/runtime-secret writes run inside a tenant/project execution context and use the current KMS epoch. The bootstrap binds the resulting ciphertext to the exact epoch that authenticated it before the request is considered successful.

A missing, revoked, unavailable or unauthenticated key fails closed. Plaintext is not returned by operator endpoints, diagnostics, metrics or runner manifests.

## Rotation

1. Verify `DATABASE_URL` and `FORGE_SECRET_ENCRYPTION_KEY` are present.
2. Call `POST /internal/crypto/rotate` as a tenant OWNER with `purpose`, optional `projectId`, `reason`, and optional `expectedEpoch`.
3. Rotation uses a PostgreSQL advisory transaction lock and an expected-epoch check to prevent concurrent stale rotations.
4. The old epoch becomes `RETIRING`; the new epoch becomes `ACTIVE`.
5. Enqueue re-encryption work for records that still reference the old epoch. Jobs use leases, `SKIP LOCKED`, bounded retries and crash recovery.
6. Do not delete old epochs until backup/restore validation and all ciphertext references have been reconciled.

## Revocation

`POST /internal/crypto/revoke` is OWNER-only and requires a tenant scope, purpose and epoch. Revocation is audited. Reads of revoked ciphertext fail closed with `KEY_EPOCH_REVOKED`.

## Backup / restore

Backups must contain PostgreSQL key-epoch metadata and wrapped DEKs, but never the root KEK. A restore is usable only when the same deployment root key (or an explicitly supported key-unwrap migration) is available. Never rotate or destroy the deployment root key as part of a database restore.

Exports must contain key references/epochs only; they must not contain wrapped keys, root keys, plaintext secrets, credentials or decrypted runner material. Existing export redaction remains the final safety boundary.

## Diagnostics and logging

Allowed telemetry: purpose, tenant-scoped operation outcome, epoch number, key fingerprint, error code and counts. Forbidden telemetry: root key, wrapped key bytes, DEKs, plaintext, ciphertext payloads, auth tags, nonces when correlated with secret material, credential material, webhook secrets or runner secret values.

## Failure handling

- `KEY_EPOCH_UNAVAILABLE`: fail closed; retry only after key metadata/storage is healthy.
- `KEY_EPOCH_REVOKED`: do not fall back to another epoch for that ciphertext.
- `CIPHERTEXT_INVALID`: treat as corruption or wrong scope; do not retry indefinitely.
- `STALE_KEY_EPOCH`: refresh key metadata and retry the operator operation with the current epoch.
- Re-encryption jobs are retryable and lease-protected. A worker crash leaves an expired lease that another worker can reclaim.

## Configuration

Required for persistent production services:

- `DATABASE_URL`
- `FORGE_SECRET_ENCRYPTION_KEY` — base64-encoded 32-byte key or exactly 32 UTF-8 bytes.

Optional:

- `FORGE_CRYPTO_POOL_MAX` — PostgreSQL pool size for key-management operations.
- `FORGE_CRYPTO_WORKER_ID` — stable worker identity for re-encryption leases.

Never place the root key in source control, migration files, backups, exports, artifacts, traces or runner manifests.
