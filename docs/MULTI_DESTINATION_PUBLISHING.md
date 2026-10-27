# Multi-Destination Publishing, Receipts and Reconciliation

Forge publishing now treats every external publication as a durable, versioned side effect behind a destination adapter contract.

## Production contract

`src/publishing/destination-contract.js` defines:

- immutable `PublishRequest` snapshots;
- destination capabilities (`resumableUpload`, receipt lookup, callbacks, deletion and retry bounds);
- destination validation;
- provider adapters and a registry;
- a non-fake adapter boundary for destinations that are not configured.

The existing YouTube path is implemented by `YouTubeDestinationAdapter` and continues to use the real YouTube resumable upload API. No unconfigured destination returns a synthetic external success.

## Durable state

Migration `099_multi_destination_publishing.sql` adds:

- `publish_requests`: immutable package/render/gate/release-epoch snapshot and idempotency identity;
- `publish_attempts`: attempt leases, provider operation keys, resumable session state, receipt IDs and diagnostics;
- `publish_receipts`: external identity ledger, scoped by tenant/project/destination;
- `publish_rate_buckets`: tenant/destination rate limiting;
- `publish_quarantine`: operator quarantine evidence.

The legacy `publish_runs` row remains the workflow-facing state and is linked to the immutable request.

## Fail-closed publication gates

Every attempt revalidates:

1. episode approval state;
2. selected approved render identity/version;
3. render checksum and storage checksum;
4. MP4 media type and storage readiness;
5. latest QA result for the exact artifact/version;
6. latest final-render approval for the exact artifact/version;
7. canonical episode package identity/hash;
8. the immutable request gate fingerprint;
9. the active release epoch.

A gate or epoch change does not trigger a blind retry. The request becomes reconciliation-required or the operator must create a new publish request from the newly approved package/version.

## Crash and timeout reconciliation

YouTube resumable upload session URIs are persisted per attempt. If the worker crashes after bytes have reached YouTube, the next attempt probes the existing session before uploading more bytes. A successful provider receipt is persisted as `publish_receipts` and reused by retries.

If the provider outcome is uncertain and the session/receipt cannot be resolved, Forge enters `RECONCILIATION_REQUIRED`, raises an operational incident, and refuses to create a second external publication.

Duplicate callbacks/receipts are absorbed by the destination/external-id uniqueness constraint. A receipt belonging to another request must never be reassigned.

## Credentials

Destination credentials use the existing tenant/project/provider-scoped encrypted runtime secret store when `FORGE_SECRET_ENCRYPTION_KEY` is configured. Recommended YouTube secret references are:

- `youtube.access_token`
- `youtube.refresh_token`
- `youtube.client_id`
- `youtube.client_secret`

Secret values are AES-256-GCM encrypted in PostgreSQL and are never written to publish receipts, audit evidence or logs. Global YouTube environment variables remain a compatibility fallback only when the scoped runtime secret store is not configured.

## Operator controls

Use the durable publishing service or `scripts/publish-operator.js`:

```text
node scripts/publish-operator.js reconcile --run-id <publish-run-id>
node scripts/publish-operator.js retry --run-id <publish-run-id>
node scripts/publish-operator.js cancel --run-id <publish-run-id> --reason "..."
node scripts/publish-operator.js quarantine --run-id <publish-run-id> --reason "..."
```

Retry is allowed only for `FAILED` runs whose immutable gate fingerprint still matches current approval/QA/package state. `RECONCILIATION_REQUIRED` is never blindly retried.

## Rate limits and backoff

Provider HTTP retry classification remains bounded inside the adapter. Forge adds tenant/destination admission limiting through `publish_rate_buckets`.

Configuration:

```text
FORGE_PUBLISH_RATE_LIMIT=10
FORGE_PUBLISH_RATE_WINDOW_SECONDS=60
YOUTUBE_MAX_ATTEMPTS=3
YOUTUBE_TIMEOUT_MS=900000
YOUTUBE_RETRY_BASE_MS=500
```

The durable job scheduler remains authoritative for worker attempts, cancellation, leases and usage/budget admission.

## Release epoch fencing

Publish requests snapshot the active `forge_release_state.epoch`. If deployment activation changes the epoch, an in-flight publication cannot silently cross the release boundary. The worker must reconcile or create a fresh request under the new release.

## Metrics and incidents

The worker emits `forge_publish_total` with bounded `destination` and `outcome` labels. Uncertain outcomes create/group an `operational_incidents` record using the existing incident detector's tenant/project model. Publish diagnostics never include provider credentials or raw artifact contents.

Recommended alerts:

- rising `publish_total{outcome="uncertain"}`;
- `RECONCILIATION_REQUIRED` age/count;
- destination 429/5xx rates;
- stale upload sessions;
- repeated gate-change failures;
- publish rate-limit saturation.

## Verification

Run:

```text
npm run check
npm test
FORGE_RUN_PUBLISH_INTEGRATION=true DATABASE_URL=<disposable-postgres> node --test test/multi-destination-publishing.test.js
npm run migrate
```

The PostgreSQL integration test is opt-in so ordinary unit runs never mutate a production database. It exercises real uniqueness/foreign-key constraints and concurrent attempt insertion against the supplied disposable PostgreSQL database.

## Failure runbook

### `RECONCILIATION_REQUIRED`

1. Do not retry the publish job.
2. Inspect the latest `publish_attempts` row and provider status/diagnostics.
3. Run `publish-operator.js reconcile`.
4. If the external receipt is found, Forge records it and completes the existing request.
5. If the receipt is still unknown, quarantine the run and investigate the destination directly.
6. Only create a new publish request after the external state and approved package/version are both known.

### `GATE_CHANGED`

The approval, QA, package, render or release state changed. Treat the original request as immutable historical evidence. Do not mutate it to fit the new state. Build a new request from the newly approved package.

### `DESTINATION_RATE_LIMIT`

Allow the durable worker retry/backoff to proceed. Do not increase concurrency to compensate. Inspect tenant/destination bucket saturation and provider quota before retrying.

### Credential rotation

Create/rotate the tenant/project/provider secret reference through the existing runtime secret controls. New attempts resolve the current active secret version; historical publish evidence contains only secret-safe references and versions.
