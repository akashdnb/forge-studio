# Episode / Project Bundle Export, Import, Backup and Operational Replay

Forge Studio bundles are deterministic, versioned, tenant-scoped recovery artifacts for moving or reconstructing a project/episode without copying secrets or live external credentials. They complement PostgreSQL disaster recovery rather than replacing it.

## Bundle format

`forge-episode-bundle` schema `1` is a gzip-compressed tar archive containing `manifest.json`, `snapshot.json`, `artifacts.json`, and `checksums.json`. The snapshot contains authorized portable metadata, provenance/version dependencies, workflow state/evidence, approval/QA/publish history, audit evidence, usage/budget evidence and a sanitized replay configuration snapshot. Artifact records retain immutable IDs, version IDs, hashes, media types, sizes and sanitized storage references; inline portable content is retained where available.

Secrets, external credentials, signed URLs, active worker leases and pending outbox delivery are excluded. Secret-shaped fields are removed recursively and URL query/credential material is stripped.

## APIs

- `GET /v2/projects/{projectId}/export` — `VIEWER` project access.
- `GET /v2/episodes/{episodeId}/export` — `VIEWER` project access.
- `POST /v2/bundles/import` — `EDITOR` access; supports `targetProjectId`, `dryRun=true`, and `allowMissingArtifacts=true`.
- `POST /v2/episodes/{episodeId}/replay` — `EDITOR` access with `{ "stageKind": "workflow:timeline", "sourceJobId": "..." }`.

Exports use a PostgreSQL `REPEATABLE READ READ ONLY` snapshot and stream the resulting archive. Imports stream uploads to a bounded private temp file, reject unsafe tar paths, verify schema and SHA-256 checksums, detect cross-tenant targets, quarantine invalid/missing bundles, and record durable import state.

## Import safety

Same-tenant imports preserve immutable identities only when there is no identity conflict. Cross-tenant imports or explicit target-project imports remap IDs. Existing immutable rows are never updated or deleted. Imported jobs are always fenced/cancelled and leases/dispatch tokens are discarded. Publish history remains evidence but external IDs/URLs are suppressed so importing cannot republish.

Duplicate bundle IDs are idempotent through `forge_bundle_imports`. Dry runs validate the complete bundle without applying rows. Missing storage-backed artifacts are quarantined by default; `allowMissingArtifacts=true` produces a metadata-only partial result marked non-replayable.

## Operational replay

Replay captures immutable historical version inputs and an optional historical source job into `forge_replay_runs`, then creates a durable `replay:stage` job. The fixture contract explicitly suppresses publishing, billing, external providers and webhooks. The worker verifies the fixture digest against the immutable input digest and produces a deterministic output digest with zero billable usage.

## CLI

```text
node scripts/forge-bundle.js export-project <projectId> <output>
node scripts/forge-bundle.js export-episode <episodeId> <output>
node scripts/forge-bundle.js import <bundle> [targetProjectId] [--dry-run]
node scripts/forge-bundle.js replay <episodeId> <stageKind> [sourceJobId]
```

## Failure/recovery runbook

1. Export and retain the reported archive SHA-256.
2. Run a dry-run import against the target tenant/project.
3. Inspect artifact hashes and any missing immutable content.
4. Apply only after dry-run diagnostics are clean.
5. Inspect `forge_bundle_imports` and `forge_replay_runs` and run normal reconciliation.
6. Replay failed stages only from immutable historical inputs.
7. Never reactivate imported jobs or publish records manually; create a new normal workflow after human review when side effects are required.

Bundle extraction enforces archive entry and byte limits. Import is transactional and retry-safe after crashes. Replay fails closed if its fixture is mutated or side-effect suppression is absent.
