# Production Media Lifecycle Reconciliation

Forge runs a bounded media lifecycle reconciler alongside the durable worker. It audits active jobs and a configurable recent terminal window, then verifies the storage/provenance contract for referenced media artifacts.

## Safety contract

- Immutable `version_records` and `artifacts` are never edited or replaced.
- Approved render/package artifacts are never silently substituted.
- A job is never promoted to `SUCCEEDED` unless every expected artifact is present, provenance-valid and checksum-verified.
- `CANCELLED` and `SUPERSEDED` jobs are never resurrected.
- Storage corruption is recorded as `MISSING` or `CORRUPT`; the artifact itself is not rewritten.
- Duplicate logical outputs are flagged using a deterministic logical key and canonical artifact id; no duplicate artifact is deleted.
- Every repair is fingerprinted and persisted in `forge_reconciliation_repairs`, making repeated runs idempotent.
- A PostgreSQL advisory lock prevents concurrent reconciler runs from applying overlapping repairs.

## What is audited

1. Expired worker leases and heartbeat failures.
2. Jobs with terminal timestamps but non-terminal status.
3. Expected artifact references on terminal success.
4. Artifact/version/episode provenance ownership.
5. Storage-object presence and database checksum agreement.
6. Real object checksum by bounded streaming download.
7. Duplicate logical outputs for media kinds.
8. Stale local `.part` files under the storage temporary directory.

## State classification

Reconciliation diagnostics use `HEALTHY`, `RECOVERABLE`, `PERMANENT`, and `CONFLICT` outcomes. Downstream consumers can treat `QUEUED` as retryable work, `FAILED` as permanently failed after retry exhaustion, `CANCELLED` as user/system cancellation, `SUPERSEDED` as no-longer-authoritative work, and a verified `SUCCEEDED` job as healthy.

## Bounds and configuration

- `FORGE_RECONCILIATION_INTERVAL_MS` — periodic scan interval; minimum 60 seconds, default 5 minutes.
- `FORGE_RECONCILIATION_SCAN_LIMIT` — jobs/artifact diagnostics per run, 1–500, default 50.
- `FORGE_RECONCILIATION_RECENT_MINUTES` — terminal-job lookback window, default 60 minutes.
- `FORGE_RECONCILIATION_PARTIAL_MAX_AGE_MINUTES` — age before local `.part` cleanup, default 60 minutes.

For an on-demand run, enqueue a `workflow:media-reconcile` durable job with an optional payload such as `{"reason":"operator-repair"}`. The normal worker lease/retry/idempotency lifecycle applies to that job.

## Operations

If a run is repeatedly `FAILED`, inspect `forge_reconciliation_runs.diagnostics` and the latest `forge_reconciliation_repairs` records. Do not manually overwrite artifact checksums or storage keys. Missing/corrupt approved output requires a new upstream render/package through the normal immutable workflow rather than in-place repair.
