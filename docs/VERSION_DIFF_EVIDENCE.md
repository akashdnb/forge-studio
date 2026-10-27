# Episode / Version Diff Evidence

Forge stores immutable, deterministic comparisons between two authorized versions of the same episode. A comparison never edits a source version, artifact, approval, QA result, workflow record or publish record.

## API
- `POST /v1/versions/:sourceVersionId/compare` with `{ "targetVersionId": "..." }`
- `POST /v1/episodes/:episodeId/compare` with `{ "sourceVersionId": "...", "targetVersionId": "..." }`
- `GET /v1/diffs/:reportId`
- `GET /v1/diffs/:reportId/items?limit=100&offset=0`
- `POST /v1/diffs/:reportId/cancel`

Compare requests are durable `workflow:version-diff` jobs. The job identity is deterministic for `(sourceVersionId,targetVersionId,schemaVersion)`, so concurrent requests collapse to one job. Completed reports are immutable and reused on later requests.

Reports use `forge-version-diff-v1`, canonical JSON ordering and SHA-256 identities. Evidence covers version graph/payload semantics, artifacts/checksums, QA, approvals, provider and publish evidence, audit events, workflow stages/state, runtime snapshots, budgets and usage reservations. Large graphs and item sets fail explicitly with `DIFF_TOO_LARGE`.

The API enforces bearer auth, tenant/project membership and RBAC. Compare/cancel require a writable project role; retrieval is available to authorized viewers. Report/item pagination is bounded to 500 items and offsets are capped. Source versions and artifacts are never mutated.

Diff jobs use the normal PostgreSQL queue, leases, retries and idempotency, with `FORGE_DIFF_MAX_CONCURRENCY`, `FORGE_DIFF_TIMEOUT_MS`, `FORGE_DIFF_MAX_NODES` and `FORGE_DIFF_MAX_ITEMS`. Metrics include `forge_version_diff_latency_seconds`, `forge_version_diff_jobs_total`, `forge_version_diff_saturation_total`, plus standard job queue/latency metrics. Replay/export consumers must preserve source/target IDs and report hash; a diff never grants approval, QA or publish authority.
