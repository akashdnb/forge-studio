# Disaster Recovery Assurance

Forge recovery is executable machinery, not a documentation-only DR plan.

## Recovery points

Backups are tenant-scoped recovery generations with database snapshot metadata, migration/schema fingerprints, encrypted artifact manifests, dependency coverage, key versions, retention and immutable HMAC-SHA256 evidence. Coverage includes workflow jobs/dependencies, execution runs, publishing, audit evidence, configuration/runtime snapshots and provider credentials. A point is last-known-good only when it is successful, integrity-verified, complete and dependency-complete. Retention never expires the protected point until a newer complete point replaces it.

## Restore drill

Use `POST /internal/recovery/operator/restore-plan` followed by `POST /internal/recovery/operator/restore-verify`, or `npm run recovery:drill`, against a disposable PostgreSQL target matching `FORGE_RECOVERY_TARGET_PREFIX`. The drill verifies encrypted archive metadata and immutable evidence, migration compatibility, deterministic dump replay, artifact checksums, provenance/content-root consistency, recovery fencing and workflow/publish invariants. It records durable phase checkpoints, failure diagnostics and measured RPO/RTO. Retries are bounded and immutable evidence is never rewritten.

## Production restoration

Keep `FORGE_ENABLE_PRODUCTION_RESTORE=false` by default. An OWNER must approve the exact backup and exact `FORGE_PRODUCTION_DATABASE_URL` through `/internal/recovery/operator/production-approval`. The approval expires and is consumed once. Production mutation also requires complete dependency coverage, last-known-good status, valid signed evidence and production artifact storage. The restore is fail-closed when the enable flag is absent or the target differs.

## Key rotation and failure injection

Keep previous signing keys in `FORGE_RECOVERY_SIGNING_KEYS_JSON` for the life of retained evidence. Exercise corrupt database/artifact archives, missing artifacts, migration drift, incompatible PostgreSQL, stale credentials/config, concurrent backup/restore, expired approval, retention candidates, worker crash and partial artifact restore. Expected behavior is durable failure evidence, no silent mutation of immutable records and bounded retry.
