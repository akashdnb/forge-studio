# Episode / Project Bundle Export, Import, Backup and Operational Replay

## Scope

Forge Studio bundles are deterministic, versioned, tenant-scoped recovery artifacts for moving or reconstructing a project/episode without copying secrets or live external credentials. The bundle is complementary to the PostgreSQL disaster-recovery backup: it is portable production metadata plus immutable artifact references/content manifests, not a database dump.

## Bundle format

`forge-episode-bundle` schema `1` is a gzip-compressed tar archive containing:

- `manifest.json` — format/version, source identity fingerprints, compatibility and replay safety policy.
- `snapshot.json` — authorized portable records, workflow/provenance state, audit evidence, usage/budget evidence and replay configuration snapshot.
- `artifacts.json` — immutable artifact IDs, version IDs, content hashes, media types, sizes, sanitized storage references and inline portable content where present.
- `checksums.json` — SHA-256 checksums for every logical bundle file.

Secrets, external credentials, signed URLs, active worker leases and pending outbox delivery are excluded. Secret-shaped fields are removed recursively and URL query/credential material is stripped.

## Export

Authenticated API endpoints:

- `GET /v2/projects/{projectId}/export` — requires project `VIEWER` access.
- `GET /v2/episodes/{episodeId}/export` — requires project `VIEWER` access.

The database snapshot uses `REPEATABLE READ READ ONLY`, so the exported graph is internally consistent. The response is streamed from the generated archive and includes `X-Bundle-Id` and `X-Bundle-SHA256` headers.

## Import

`POST /v2/bundles/import` requires `EDITOR` access. Upload the archive with a bundle-compatible content type. Optional query parameters:

- `targetProjectId` — import into an existing project owned by the authenticated tenant.
- `dryRun=true` — validate and reconcile without applying records.
- `allowMissingArtifacts=true` — permit metadata-only partial import; the response marks the result non-replayable when referenced immutable content is unavailable.

Import is idempotent by immutable bundle ID and protected by `forge_bundle_imports`. Invalid or incomplete bundles are quarantined rather than partially applied. Existing immutable identities are preserved only when the source tenant fingerprint matches the authenticated tenant; otherwise IDs are remapped. Existing immutable rows are never updated or deleted.

Operational jobs are fenced on import: queued/running jobs are not resumed, leases are not copied, and imported publish records cannot trigger an external upload. Published history is retained as evidence while active external IDs are suppressed.

## Operational replay

`POST /v2/episodes/{episodeId}/replay` requires `EDITOR` access and accepts `{ "stageKind": "workflow:timeline", "sourceJobId": "..." }`.

A replay captures immutable historical version inputs and the source job payload into `forge_replay_runs`. It enqueues a durable `replay:stage` job. The replay worker requires explicit suppression of publishing, billing, external providers and webhooks. Its deterministic fixture digest is checked against the immutable input digest before execution.

Replay is therefore safe for incident diagnosis and deterministic regression verification; it cannot accidentally republish an episode or create billable provider work.

## Failure and recovery behavior

| Condition | Behavior |
| --- | --- |
| Oversized upload | Reject before extraction; no DB mutation |
| Path traversal / unsafe tar entry | Reject and quarantine |
| Corrupt checksum | Reject and quarantine |
| Unsupported schema | Reject with compatibility error |
| Cross-tenant target project | 403; no import |
| Duplicate bundle | Return prior terminal result; no duplicate rows |
| Missing artifact reference | Quarantine by default; optional metadata-only partial import |
| Crash during import | Transaction rolls back; import record is retryable unless terminal/quarantined |
| Stale imported jobs | Never restored as active; leases and dispatch tokens are fenced |
| Replay fixture mutation | Fail closed with `REPLAY_INPUT_MUTATED` |
| External side effects | Explicitly disabled for replay and imported publish history |

## CLI

```text
node scripts/forge-bundle.js export-project <projectId> <output>
node scripts/forge-bundle.js export-episode <episodeId> <output>
node scripts/forge-bundle.js import <bundle> [targetProjectId] [--dry-run]
node scripts/forge-bundle.js replay <episodeId> <stageKind> [sourceJobId]
```

The CLI requires `DATABASE_URL` and uses `FORGE_STATIC_ACTOR_ID` / `FORGE_STATIC_TENANT_ID` when supplied.

## Metrics and diagnostics

Bundle operations emit `forge_bundle_operations_total` with operation/outcome labels. Replay jobs also flow through the standard durable-job observability and usage-accounting path with zero billable usage. The import row retains checksum, schema, checkpoint, diagnostics and terminal status for incident reconciliation.

## Operator runbook

1. Export from the source tenant and retain the reported SHA-256.
2. Validate with `dryRun=true` against the target tenant/project.
3. Confirm artifact hashes and any intentionally missing immutable content.
4. Apply the import only after dry-run diagnostics are clean.
5. Run reconciliation and inspect `forge_bundle_imports` plus `forge_replay_runs`.
6. Replay failed stages using a historical source job/version set; verify deterministic output digest.
7. Do not manually reactivate imported jobs or publish records. Create a new normal workflow after human review if production side effects are required.

## Security invariants

- Tenant authorization is checked before export/import/replay.
- Source tenant identity is represented by a one-way fingerprint.
- Secrets and credentials never enter the bundle.
- Existing immutable artifact/version/provenance records are not mutated.
- Bundle extraction rejects unsafe paths and enforces entry/size limits.
- Import and replay are transactionally durable and idempotent.
- Replay cannot access provider credentials through the fixture contract and reports zero billable usage.
