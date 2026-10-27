# Production Recovery Runbook

Forge recovery has two immutable recovery artifacts per backup: the PostgreSQL custom-format archive and a content-addressed artifact archive. The database manifest records migration/schema fingerprints, WAL recovery point, artifact checksums and a deterministic content root. The artifact archive contains checksum-verified bytes keyed by their immutable SHA-256 identity.

## Operator boundary

Recovery mutation endpoints are exposed only by `npm run recovery:operator` and require an authenticated Forge OWNER identity. The token tenant is bound to the backup/recovery audit record. Recovery targets must be explicitly isolated with `FORGE_RECOVERY_TARGET_PREFIX`; `FORGE_RESTORE_ALLOW_NONISOLATED=true` is an emergency-only override and must not be enabled in production.

Endpoints:

- `POST /internal/recovery/operator/backups` — create or dry-run a backup.
- `POST /internal/recovery/operator/restore-plan` — verify an archive and produce a non-mutating restore plan.
- `POST /internal/recovery/operator/restore-verify` — restore into the isolated target, restore immutable artifacts into isolated target storage, fence restored work and verify invariants before declaring success.

## Recovery phases

1. **Preflight** — authenticate operator, verify tenant, verify archive authentication/checksums and reject duplicate active restores.
2. **Compatibility** — verify PostgreSQL major version and migration/schema fingerprints before `pg_restore`.
3. **Restore** — restore the database into the isolated target only.
4. **Artifact restore** — restore only content-addressed bytes whose SHA-256 matches the manifest.
5. **Fencing** — advance the recovery epoch, invalidate active leases/external executions, clear scheduler state and increment durable dispatch generations.
6. **Verification** — verify provenance reachability, artifact metadata/checksums, lifecycle state integrity, approval/QA/publish links, job consistency, audit scope and usage/config state before success.
7. **Complete** — mark the operation successful only after every checkpoint passes.

Every phase writes a durable checkpoint with a deterministic checksum. A crashed operation remains durable in PostgreSQL and is never silently treated as successful. A retry must use a clean disposable target; the original production database and production artifact store are never used as a verification target.

## Failure handling

- **Corrupt snapshot/metadata:** fail before database mutation.
- **Missing/corrupt artifact:** fail the backup or restore; never substitute a different content hash.
- **Schema/migration mismatch:** fail before `pg_restore`.
- **Duplicate restore:** return `409` while another restore is active.
- **Storage outage:** fail closed and leave the recovery operation checkpointed for retry.
- **Interrupted restore:** target remains disposable; resume by replaying the same immutable recovery point into a fresh target.
- **Stale workers:** recovery epoch + dispatch generation + worker ownership checks prevent a pre-recovery execution from completing a restored job attempt.
- **Tenant mismatch:** operator authentication is tenant-bound and recovery audit records retain the tenant scope.

## RPO / RTO

`FORGE_BACKUP_PITR_ENABLED=true` records the PostgreSQL WAL LSN and assumes an external WAL archive. It does not provide WAL archiving itself. Without PITR, the latest successful immutable backup is the recovery point.

RTO is measured by the completed isolated restore drill. The recovery service bounds external commands with `FORGE_BACKUP_TIMEOUT_MS` and bounds artifact concurrency with `FORGE_RECOVERY_ARTIFACT_CONCURRENCY`.

## Verification checklist

- [ ] backup archive SHA-256 matches the recovery record
- [ ] encrypted metadata authentication succeeds
- [ ] PostgreSQL major version is compatible
- [ ] migration fingerprint and schema fingerprint are compatible
- [ ] artifact manifest root is deterministic
- [ ] every artifact exists and its bytes hash to the manifest content hash
- [ ] every artifact points to an existing immutable version
- [ ] version dependency graph is reachable
- [ ] QA and approval targets resolve to existing versions/artifacts
- [ ] publish runs resolve to the approved render
- [ ] durable jobs have valid dependencies and no impossible running leases
- [ ] security/audit events remain tenant-scoped and timestamped
- [ ] usage/budget state is structurally valid
- [ ] lifecycle state constraints remain valid
- [ ] recovery epoch was advanced and pre-recovery executions were fenced
- [ ] no production database or production artifact store was mutated
