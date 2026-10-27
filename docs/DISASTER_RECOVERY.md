# Backup, Restore & Disaster Recovery

Forge Studio recovery is a vertical slice, not a dump-only script. A backup contains a PostgreSQL custom-format dump plus an encrypted/compressed recovery manifest. The manifest records schema/migration identity, a PostgreSQL snapshot/WAL position, and a bounded inventory of immutable artifact references.

## Recovery guarantees

- PostgreSQL backups use `REPEATABLE READ` plus `pg_export_snapshot()` and pass that snapshot to `pg_dump`, preventing a backup from mixing database states.
- A PostgreSQL advisory lock serializes backup/restore operations.
- Artifact inventory is collected from the same database snapshot and every referenced object is checked for existence, size and (when enabled) content checksum.
- Metadata is gzip-compressed and AES-256-GCM encrypted. Secrets, credentials and raw provider payloads are never written to the manifest.
- Backup archives are verified by extraction and authenticated metadata decryption before restore.
- Restore is ordered: preflight/archive verification → PostgreSQL compatibility → `pg_restore` → job/runner fencing → scheduler reset → provenance/storage reconciliation.
- Running durable jobs are re-queued with a new dispatch generation; external execution rows are marked `STALE`; scheduler heartbeats are cleared so restored workers cannot inherit old leases.
- Restore is idempotent at the operation boundary and records a fencing token and phase in `forge_restore_operations`.
- Retention is bounded and removes expired archive files before marking the ledger row `EXPIRED`.

## Commands

Set `DATABASE_URL` and a base64-encoded 32-byte `FORGE_BACKUP_ENCRYPTION_KEY`.

```bash
npm run backup
npm run backup -- --dry-run
npm run backup -- --no-verify
npm run backup:verify -- .forge-backups/<backup-id>.tar.gz
npm run backup:restore -- .forge-backups/<backup-id>.tar.gz <isolated-target-database-url>
npm run backup:restore -- .forge-backups/<backup-id>.tar.gz <isolated-target-database-url> --dry-run
npm run backup:retention
```

Restore targets must be disposable/isolated databases. Do not point restore at the live production database unless the incident runbook explicitly authorizes a controlled replacement procedure.

## RPO / RTO

`FORGE_BACKUP_PITR_ENABLED=true` means Forge records a WAL LSN and assumes external PostgreSQL WAL archiving is configured. It does **not** enable PITR by itself. Without WAL archiving, the recoverable point is the last completed backup snapshot.

The recovery service bounds long-running `pg_dump`, `pg_restore`, and archive operations with `FORGE_BACKUP_TIMEOUT_MS`. RTO is workload-dependent and should be measured by scheduled restore drills rather than estimated from archive size alone.

## Failure handling

- **Missing artifact / checksum mismatch:** backup fails closed; no successful backup record is produced.
- **Corrupt archive / bad authentication tag:** verification and restore stop before database mutation.
- **Incompatible PostgreSQL / migration fingerprint:** restore is rejected before `pg_restore`.
- **Interrupted restore:** the restore ledger remains failed and the target database is considered disposable. Re-run into a clean isolated target; the same backup is replayable.
- **Stale jobs or leases:** all `RUNNING` durable jobs are fenced and re-queued; external GitHub execution records are marked stale.
- **Orphaned artifacts:** post-restore reconciliation fails closed and reports the diagnostic count.
- **Duplicate identities:** restore reconciliation detects duplicate job identities and fails closed.

## Operational policy

1. Schedule backups at an interval matching the business RPO.
2. Keep the encryption key outside the backup archive and outside application logs.
3. Store archives on a separate durable backend from the primary database where possible.
4. Run a disposable restore drill at least as often as the retention policy requires.
5. Verify artifact checksums during routine backups; use `--no-verify` only for explicitly bounded emergency snapshots.
6. Keep the last known-good application/migration release available for compatibility validation.
7. Treat a successful `pg_restore` as an intermediate state; the restore is not complete until reconciliation succeeds.

## Metrics / diagnostics

The recovery ledger provides status, bytes, artifact counts, verification counts, retention expiry, PostgreSQL version, migration fingerprint, WAL LSN and phase/error codes. The CLI emits only structured diagnostics and redacted database identifiers.

The protected recovery HTTP integration is provided by `src/recovery/recovery-http.js`; deployments should expose it only to OWNER-level operational identities and only on an internal network. It provides health and RPO/RTO diagnostics without returning credentials or raw artifact contents.
