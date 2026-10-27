# Immutable Artifact Lifecycle and Safe Garbage Collection

Forge artifacts are immutable content-addressed objects. Lifecycle cleanup never rewrites or deletes an `artifacts` row or a surviving provenance/version record. It only changes the durable lifecycle ledger and, after all safety gates pass, removes the physical storage object.

## States

- `RETAINED`: normal immutable storage.
- `PROTECTED`: a live provenance, workflow, approval, QA, publish, episode, or hold reference exists.
- `QUARANTINED`: retention has expired and no protection reference was observed; the object remains available during the recovery grace period.
- `DELETION_PENDING`: quarantine grace elapsed; the worker performs a fresh reference check before calling the storage provider.
- `DELETED`: the provider accepted deletion and the storage metadata is marked `DELETED`. The artifact/provenance row remains immutable.

A provider failure leaves the lifecycle row `DELETION_PENDING` and records an auditable failure event. Re-running the worker retries the same deterministic candidate.

## Safety model

An artifact is protected when any of the following is true:

1. Its version is reachable from the episode's current/approved version roots through `version_dependencies`.
2. The artifact/version is referenced by an active job or provider run.
3. An approved version, passing/warning QA result, publish run, or ready package references it.
4. The episode is still in a live production state.
5. A legal, safety, recovery, or manual `artifact_holds` row is active.
6. A reference reappears during the final pre-delete transaction check.

Reference accounting is deliberately conservative. Duplicate logical references are counted rather than collapsed for safety; the lifecycle worker never elects a canonical artifact and never mutates duplicate artifact records.

## Retention

Defaults are configured in `render.yaml` and can be overridden with `FORGE_ARTIFACT_RETENTION_DAYS_JSON`. Example:

```json
{"render":90,"package":365,"audio":90,"image":90,"video":90,"caption":90,"render-manifest":90,"default":30}
```

`storage_objects.expires_at`, when present, is authoritative and can shorten a class-specific retention period. Retention is never sufficient by itself: every candidate still passes all reference/protection gates.

## Execution

The worker runs every 15 minutes by default and uses a PostgreSQL advisory lock so only one lifecycle scan is active. Each scan is bounded by `FORGE_ARTIFACT_LIFECYCLE_SCAN_LIMIT`.

The durable job kind `workflow:artifact-lifecycle` supports on-demand execution. Its payload may include:

```json
{"reason":"operator cleanup","dryRun":true}
```

Dry-run performs the same reference and retention evaluation but does not quarantine or delete anything. Lifecycle events record the decision.

## Crash and provider recovery

Lifecycle state is durable. A process crash before the provider call leaves a `DELETION_PENDING` candidate for the next run. A provider failure leaves the candidate pending with `last_error`. A successful provider delete is followed by a transaction that re-checks references and records `DELETED`; if a late protection signal is observed, the lifecycle state is changed to `PROTECTED` and the immutable database records are left untouched.

Because the storage keys are content-addressed, deleting an object never changes the identity of a surviving artifact. Downstream consumers must treat `storage_objects.status='DELETED'` as an unavailable artifact and use reconciliation/recovery rather than replacing the artifact in place.

## Operational checks

Before enabling enforcement in production:

1. Apply migrations with `npm run migrate`.
2. Run a dry-run and inspect `artifact_lifecycle_runs` and `artifact_lifecycle_events`.
3. Verify the configured S3 bucket/versioning and recovery policy.
4. Confirm `FORGE_ARTIFACT_LIFECYCLE_SCAN_LIMIT` is bounded for the database/storage capacity.
5. Start with a conservative quarantine window and retention policy.

Useful queries:

```sql
SELECT state, count(*) FROM artifact_lifecycle_records GROUP BY state ORDER BY state;
SELECT action, count(*) FROM artifact_lifecycle_events GROUP BY action ORDER BY action;
SELECT * FROM artifact_lifecycle_runs ORDER BY started_at DESC LIMIT 20;
```

The media reconciliation worker remains responsible for detecting missing/corrupt objects and stale job state. It does not resurrect a lifecycle-deleted artifact or replace immutable provenance.
