# Disaster Recovery Assurance

Forge recovery is an executable control-plane capability, not a documentation-only DR plan.

## Recovery point lifecycle

1. An operator creates a tenant-scoped backup through the recovery operator API.
2. PostgreSQL is captured with a repeatable-read snapshot and the migration fingerprint is recorded.
3. Artifact bytes are checksum-verified and archived with an encrypted manifest.
4. A backup generation is allocated atomically per tenant. The newest verified generation is marked last-known-good; retention never expires that point until a newer successful generation replaces it.
5. Coverage checks verify the required control-plane tables exist, including tenants/projects, workflow jobs, publishing, audit evidence, runtime/config snapshots and provider credentials. Missing dependencies mark the recovery point incomplete.
6. An immutable HMAC-SHA256 evidence record signs the canonical recovery metadata. Key rotation is supported through `FORGE_RECOVERY_SIGNING_KEYS_JSON`; old verification keys must remain available for the lifetime of retained evidence.

## Restore drill

Use `POST /internal/recovery/operator/restore-plan`, followed by `POST /internal/recovery/operator/restore-verify`, with a disposable PostgreSQL target matching `FORGE_RECOVERY_TARGET_PREFIX` and an isolated artifact store. The verifier:

- checks the archive and encrypted metadata;
- verifies the immutable signed recovery evidence;
- checks PostgreSQL major-version compatibility and migration fingerprints;
- replays the dump with `pg_restore --single-transaction`;
- restores artifact bytes and re-verifies checksums;
- fences stale durable jobs/executions with a new recovery epoch;
- checks orphaned episodes/versions/dependencies/artifacts/storage/approvals/publish records and invalid running leases;
- reconciles the restored artifact Merkle root against the backup manifest; and
- persists phase checkpoints, diagnostics, measured RPO and RTO.

Failed or partial drills remain durable failures. Retries are bounded and do not mutate immutable evidence.

## Production restoration

Production mutation is fail-closed. Configure `FORGE_PRODUCTION_DATABASE_URL`, keep `FORGE_ENABLE_PRODUCTION_RESTORE=false` by default, and require an OWNER-authenticated operator to call `POST /internal/recovery/operator/production-approval` for the exact backup and production target. The approval expires and is consumed once.

The production restore endpoint additionally requires `FORGE_ENABLE_PRODUCTION_RESTORE=true`, the exact configured production URL, the still-valid approval, the signed backup evidence and production artifact storage. It re-verifies the backup before mutation and records the measured RTO and recovery epoch in the durable restore operation.

Do not treat a backup as a last-known-good point unless `status=SUCCEEDED`, `integrity_status=VERIFIED`, `coverage_status=COMPLETE`, `dependency_complete=true` and a valid immutable integrity record exists.

## Key rotation

Rotate backup encryption keys independently from evidence-signing keys. Retain old signing keys for all unexpired evidence. A restore must fail closed if the key needed to verify the evidence is unavailable or the signed payload has drifted.

## Failure injection and recovery testing

Before release, exercise at least: corrupt database archive, corrupt encrypted artifact archive, missing artifact object, migration fingerprint drift, incompatible PostgreSQL version, missing runtime/config dependency, stale credential/config snapshot, concurrent backup, concurrent restore, expired approval, expired retention candidate, worker crash during restore, and recovery retry after a partial artifact restore.

The expected behavior is durable failure evidence, no silent repair of immutable records, bounded retry, and an operator-visible recovery status.
