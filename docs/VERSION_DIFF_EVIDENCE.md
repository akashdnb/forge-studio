# Episode / Version Diff Evidence

Forge stores immutable, deterministic comparisons between two authorized versions of the same episode. A comparison never edits a source version, artifact, approval, QA result, workflow record or publish record.

## API
- `POST /v1/versions/:sourceVersionId/compare` with `{ "targetVersionId": "..." }`
- `POST /v1/episodes/:episodeId/compare` with `{ "sourceVersionId": "...", "targetVersionId": "..." }`
- `GET /v1/diffs/:reportId`
- `GET /v1/diffs/:reportId/items?limit=100&offset=0`
- `POST /v1/diffs/:reportId/cancel`

Compare requests are durable `workflow:version-diff` jobs with deterministic idempotency. Reports use canonical JSON/SHA-256 identities and cover version graph/payload semantics, artifacts/checksums, QA, approvals, provider/publish/audit evidence, workflow stages/state, runtime snapshots, budgets and usage reservations. Large graphs/items fail with `DIFF_TOO_LARGE`.

The API enforces bearer auth, tenant/project membership and RBAC. Compare/cancel require a writable project role; retrieval is available to authorized viewers. Pagination is bounded to 500 items and offsets are capped. Source versions and artifacts are never mutated.

Diff jobs use normal PostgreSQL queue leases/retries plus cancellation, timeout and concurrency limits. Metrics include `forge_version_diff_latency_seconds`, `forge_version_diff_jobs_total`, `forge_version_diff_saturation_total`, and standard job queue metrics. Replay/export consumers preserve source/target IDs and report hash; a diff never grants approval, QA or publish authority.
