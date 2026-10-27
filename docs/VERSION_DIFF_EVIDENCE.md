# Episode / Version Diff Evidence

Forge stores immutable, deterministic comparisons between two authorized versions of the same episode. The source version/artifact graph is read-only.

APIs: `POST /v1/versions/:sourceVersionId/compare`, `POST /v1/episodes/:episodeId/compare`, `GET /v1/diffs/:reportId`, `GET /v1/diffs/:reportId/items?limit=100&offset=0`, and `POST /v1/diffs/:reportId/cancel`.

Reports use `forge-version-diff-v1`, canonical JSON ordering and SHA-256 identities. Evidence covers version graph/payload semantics, scripts/scenes/narration/timeline payloads, artifacts/checksums, QA, approvals, provider/publish/audit evidence, workflow stages/state, runtime snapshots, budgets and usage reservations. Missing/quarantined/corrupt references remain evidence; they are never rewritten.

Compare requests are durable `workflow:version-diff` jobs with deterministic idempotency, queue leases/retries, cancellation, timeout, graph/item limits and worker concurrency limits. Completed reports/items are DB-immutable. Pagination is capped at 500 rows with a bounded offset. Metrics include `forge_version_diff_latency_seconds`, `forge_version_diff_jobs_total` and `forge_version_diff_saturation_total` alongside standard job queue metrics.

The APIs enforce tenant/project membership and RBAC; compare/cancel require a writable project role and retrieval is viewer-safe. Replay/export must preserve source/target IDs and report hash and cannot treat diff evidence as an approval, QA or publish grant.
