# Disaster Recovery Assurance

Forge recovery is an executable control-plane capability, not a documentation-only DR plan.

## Recovery point lifecycle

1. An operator creates a tenant-scoped backup through the recovery operator API.
2. PostgreSQL is captured with a repeatable-read snapshot and the migration fingerprint is recorded.
3. Artifact bytes are checksum-verified and archived with an encrypted manifest.
4. A backup generation is allocated atomically per tenant. Only a complete, dependency-complete verified generation is marked last-known-good; retention never expires that point until a newer successful generation replaces it.
5. Coverage checks verify the required control-plane tables exist, including tenants/projects, workflow jobs, publishing, audit evidence, runtime/config snapshots and provider credentials. Missing dependencies mark the recovery point incomplete.
6. An immutable HMAC-SHA256 evidence record signs the canonical recovery metadata. Key rotation is supported through `FORGE_RECOVERY_SIGNING_KEYS_JSON`; old verification keys must remain available for the lifetime of retained evidence.

## Restore drill

Use `POST /internal/recovery/operator/restore-plan`, followed by `POST /internal/recovery/operator/restore-verify`, with a disposable PostgreSQL target matching `FORGE_RECOVERY_TARGET_PREFIX` and an isolated artifact store. The verifier checks the archive and encrypted metadata, immutable evidence, PostgreSQL/migration compatibility, dump replay, artifact checksums, recovery fencing, workflow/publish/provenance invariants and persists phase checkpoints plus measured RPO/RTO.

`npm run recovery:drill` automates selection of the newest eligible tenant recovery point and executes the disposable drill. Failed or partial drills remain durable failures. Retries are bounded and do not mutate immutable evidence.

## Production restoration

Production mutation is fail-closed. Configure `FORGE_PRODUCTION_DATABASE_URL`, keep `FORGE_ENABLE_PRODUCTION_RESTORE=false` by default, and require an OWNER-authenticated operator to call `POST /internal/recovery/operator/production-approval` for the exact backup and production target. The approval expires and is consumed once.

The production restore endpoint additionally requires the enable flag, exact configured production URL, still-valid approval, signed backup evidence, complete dependency coverage and last-known-good status, plus production artifact storage. It re-verifies the backup before mutation and records measured RTO and recovery epoch.

## Key rotation and failure injection

Rotate backup encryption keys independently from evidence-signing keys. Retain old signing keys for all unexpired evidence. Exercise corrupt database/artifact archives, missing artifacts, migration drift, incompatible PostgreSQL, stale credentials/config, concurrent backup/restore, expired approval, retention candidates, worker crash and partial artifact restore. Expected behavior is durable failure evidence, no silent mutation of immutable records and bounded retry.
