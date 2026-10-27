# Editorial Review, Comments, Annotations and Decision Evidence

Forge Studio review data is durable PostgreSQL state, not a UI cache. Every thread is scoped to tenant/project/episode/**immutable version** and every comment edit/delete is represented by an immutable revision row.

## API

All endpoints require the normal Forge bearer identity and project membership.

- `POST /v1/reviews/threads` — create a thread. Requires `EDITOR`.
- `GET /v1/reviews/threads?projectId=&episodeId=&versionId=` — deterministic `(created_at,id)` ordering. Requires `VIEWER`.
- `POST /v1/reviews/threads/:threadId/comments` — create comment revision. Requires `EDITOR`.
- `PUT /v1/reviews/comments/:commentId` — append an `EDIT` revision; requires `expectedRevision`.
- `DELETE /v1/reviews/comments/:commentId` — append a `DELETE` tombstone; requires `expectedRevision`.
- `POST /v1/reviews/threads/:threadId/resolve` — resolve/reopen with optimistic `expectedRevision`. Requires `EDITOR`.
- `POST /v1/reviews/threads/:threadId/decision` — durable reviewer decision/evidence. Requires `OWNER`.
- `GET /v1/reviews/gate?projectId=&episodeId=&versionId=` — release gate evaluation.
- `GET /v1/reviews/export?...` — canonical deterministic bundle plus SHA-256 checksum.
- `POST /v1/reviews/replay` — deterministic idempotent replay into the same immutable version. Requires `OWNER`.
- `GET /v1/reviews/diagnostics?projectId=` — operational counts and unresolved gate findings. Requires `OWNER`.

### Anchors

`anchorType` is one of `EPISODE`, `VERSION`, `SCENE`, `TIMELINE_RANGE`, or `ARTIFACT_TIMESTAMP`. A `versionId` is mandatory for all anchors. Scene anchors carry `sceneId`; timeline anchors carry non-negative `startMs < endMs`; artifact timestamp anchors carry `artifactId` and `timestampMs`. Artifact references must belong to the same episode/version/project and cannot be deleted, quarantined, corrupt or missing.

## History and concurrency

Comments are append-only revisions. `CREATE`, `EDIT`, and `DELETE` are never overwritten. A caller must supply the revision it last observed when editing/deleting or resolving; PostgreSQL row locking makes conflicting writers deterministic and returns `REVISION_CONFLICT`.

Idempotency keys are tenant-scoped and bind to a canonical SHA-256 request hash. Reusing a key with different input fails closed with `IDEMPOTENCY_CONFLICT`.

## Release evidence

A `required_for_release` unresolved thread blocks the editorial review gate. Project-level `review_gate_requirements` can additionally require a decision quorum. The canonical publish package gate checks the exact immutable package version before publishing, so a finding on another version cannot silently block or satisfy the release.

Resolved findings, reviewer decisions, audit events and durable notification events remain evidence. Review notifications are written transactionally to `forge_events` and `forge_outbox` and are delivered by the existing durable delivery worker.

## Lifecycle and tenant isolation

Review mutations require an `ACTIVE` tenant and project. Database triggers enforce tenant/project/episode/version provenance. Deleted, suspended, archived, quarantined and otherwise unavailable resources fail closed. No endpoint accepts a tenant identifier from the URL as an authorization override; tenant identity always comes from the authenticated principal.

## Export/replay

Exports sort threads, revisions and decisions deterministically and include a canonical SHA-256 checksum. Replay requires the same tenant/project/episode/version scope and checksum, uses `ON CONFLICT DO NOTHING`, and records a replay checkpoint hash.

## Diagnostics and runbook

Use `GET /v1/reviews/diagnostics` to inspect thread states, comment revision volume, decisions and unresolved required findings. For a blocked publish:

1. Query the exact package/render version with `GET /v1/reviews/gate`.
2. Resolve only findings on that immutable version; do not migrate anchors implicitly.
3. Record the required reviewer decision if the project gate requires quorum.
4. Re-run the publish gate. Never manually mutate review rows or delete history.
5. If replay is required, export first, verify the checksum, then replay with an `OWNER` identity.

Migration `027_editorial_review.sql` must be applied before enabling review endpoints. Review events use the existing durable outbox/delivery infrastructure; no separate notification store is required.
