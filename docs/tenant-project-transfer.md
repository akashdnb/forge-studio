# Tenant / Project Transfer, Import Validation, and Disaster Replay

Forge Studio now exposes a durable transfer control plane for tenant/project snapshots and deterministic workflow replay packages.

## Safety model

- Export scope is tenant or project and is always resolved from the authenticated tenant.
- Snapshots are created under PostgreSQL `REPEATABLE READ` so database state is internally consistent.
- Dependency closure follows project/tenant scope columns and PostgreSQL foreign-key relationships.
- Credential-bearing fields, live leases, live credentials, signed URLs and worker dispatch state are redacted/excluded.
- Artifact bytes are content-addressed and every chunk is SHA-256 verified through the existing storage abstraction (local or S3).
- The manifest carries schema version, migration version, schema fingerprint, dependency closure, artifact references, a content root and HMAC-signed evidence.
- Import never mutates source history. IDs are remapped into the target tenant/project and source-to-target mappings are durable.
- Import application requires explicit OWNER approval after validation. Failed imports can be rolled back using the durable identity map.

## API

- `POST /v2/transfer/tenants/export` — OWNER; enqueue a tenant export.
- `POST /v2/transfer/projects/:projectId/export` — OWNER; enqueue a project export.
- `GET /v2/transfer/exports/:id` — view export status/checkpoint.
- `GET /v2/transfer/exports/:id/download` — download the content-addressed package.
- `POST /v2/transfer/imports` — OWNER; upload a package. The body is streamed to temporary storage and chunked before validation.
- `GET /v2/transfer/imports/:id` — validation/conflict report.
- `POST /v2/transfer/imports/:id/approve` — OWNER approval gate.
- `POST /v2/transfer/imports/:id/apply` — OWNER; enqueue the isolated apply.
- `POST /v2/transfer/imports/:id/rollback` — OWNER; remove only rows recorded by the import identity map.
- `POST /v2/transfer/projects/:projectId/replay` — EDITOR; create a deterministic, side-effect-suppressed job reconstruction package.
- `GET /v2/transfer/replays/:id/download` — download a replay package.

Use an `Idempotency-Key` on export/import mutations. Worker leases and job retries make transfer processing resumable after crashes; export/import chunks already present and checksum-matching are reused.

## Signing and key rotation

Configure `FORGE_TRANSFER_SIGNING_KEY` as base64 key material and `FORGE_TRANSFER_SIGNING_KEY_ID` as its version. For rotation, set `FORGE_TRANSFER_SIGNING_KEYS` to a comma-separated `key-id=base64-key` ring while the new key is active. Imports accept any trusted key in the ring, so old packages remain verifiable during rotation.

Recommended production values:

- `FORGE_TRANSFER_CHUNK_BYTES=8388608`
- `FORGE_TRANSFER_MAX_BYTES` sized below the storage/provider request limit.
- A dedicated transfer signing key with regular rotation and access auditing.
- Existing `FORGE_STORAGE_DRIVER`, `FORGE_STORAGE_S3_*`, or local storage configuration; no transfer-specific storage bypass is required.

## Operations / diagnostics

Worker metrics are emitted under `forge_transfer_*`. Investigate `QUARANTINED` imports before approval; common causes are missing source artifacts, missing target columns/tables, source migration newer than the target, or an untrusted signing key. `PARTIAL` exports/imports are safe to retry: chunk checksums and durable checkpoints prevent duplicate writes.

For disaster replay, packages contain historical job inputs/results and provenance references only. They explicitly suppress side effects and exclude live credentials. Replay packages are reconstruction evidence, not permission to execute a production job.
