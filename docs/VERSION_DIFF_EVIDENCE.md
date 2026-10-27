# Episode / Version Diff Evidence

Forge stores immutable, deterministic comparisons between two authorized versions of the same episode. A comparison never edits a source version, artifact, approval, QA result, workflow record or publish record.

## API

- `POST /v1/versions/:sourceVersionId/compare` with `{ "targetVersionId": "..." }`
- `POST /v1/episodes/:episodeId/compare` with `{ "sourceVersionId": "...", "targetVersionId": "..." }`
- `GET /v1/diffs/:reportId`
- `GET /v1/diffs/:reportId/items?limit=100&offset=0`
- `POST /v1/diffs/:reportId/cancel`

Compare requests are durable `workflow:version-diff` jobs. The job identity is deterministic for `(sourceVersionId,targetVersionId,schemaVersion)`, so concurrent requests collapse to one job. Completed reports are immutable and are reused on later requests.

## Evidence contract

Reports use `forge-version-diff-v1`, canonical JSON ordering and SHA-256 identities. Changes cover version graph membership and payload semantics plus artifacts, QA, approvals, provider runs, publish evidence, audit evidence and usage/cost evidence available for the compared graph. Artifact references are recorded by immutable IDs and checksums; the diff does not dereference or rewrite storage objects.

Pagination is ordinal/keyset-stable over the persisted diff-item table. Limits are bounded to 500. Large graph/item counts fail explicitly with `DIFF_TOO_LARGE` instead of unbounded memory growth.

## Durability and recovery

Diff jobs use the normal Forge PostgreSQL job queue, leases, retries, idempotency keys, cancellation and worker accounting. `FORGE_DIFF_MAX_CONCURRENCY`, `FORGE_DIFF_TIMEOUT_MS`, `FORGE_DIFF_MAX_NODES` and `FORGE_DIFF_MAX_ITEMS` bound resource use. Timeout/cancellation produces a terminal report state without modifying source versions.

## Security

The API is behind Forge's existing bearer-token, tenant and project membership/RBAC middleware. Version pairs are verified to belong to the same episode before enqueue. The outer API resource authorization resolves version routes through their owning episode, preventing cross-project IDOR. Reports and pages are only reachable through the same protected API.

## Operations / diagnostics

The existing Operations Control Plane can inspect the durable job and audit evidence associated with a diff. Metrics include `forge_version_diff_latency_seconds`, `forge_version_diff_jobs_total`, `forge_version_diff_saturation_total`, normal `forge_jobs_total`/`forge_job_duration_seconds`, and queue-depth metrics. Use the existing `/internal/observability/metrics` and `/internal/observability/diagnostics` endpoints for operator diagnostics.

## Replay/export safety

Diff evidence is read-only evidence over immutable source records. Replay or export paths must preserve the source/target version IDs and report hash; they must not use a diff report as an authorization or publication grant. Normal approval, QA and publish gates remain authoritative.
