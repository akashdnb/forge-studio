# Release engineering and migration safety

Forge releases are treated as a compatibility window, not a single binary rollout. The release manifest is the source of truth for commit identity, application/schema versions, worker contracts, required configuration/indexes, feature flags and rollback policy. Evidence is persisted without secret values.

## Preflight

1. Build a release manifest from `release-manifest.example.json` and set the real commit SHA/release ID.
2. Run `DATABASE_URL=... npm run migrate`. The migration runner takes a PostgreSQL advisory lock, verifies checksums, strips legacy transaction-control wrappers, applies each migration atomically, and never marks a failed migration as applied.
3. Run `DATABASE_URL=... npm run release:preflight -- --manifest release-manifest.json`.
4. Do not bypass `MIGRATION_PREFLIGHT_FAILED`, checksum mismatch, unsafe pending DDL, missing required indexes/configuration, or an invalid schema compatibility window.

Destructive SQL is blocked unless the migration contains an explicit `-- forge:allow-destructive reason=...` annotation. Existing legacy duplicate `007_*` prefixes are reported as evidence but are preserved for backward compatibility; new duplicate prefixes at 009+ are release-blocking.

## Expand/contract

Use three releases for incompatible data shape changes:

- **Expand:** add nullable/new columns, indexes and compatibility readers. Keep old workers able to read/write the old representation.
- **Migrate:** dual-write/backfill and observe. Keep the old representation until all workers are outside the compatibility window.
- **Contract:** only after the manifest declares the old worker/schema version fenced. Destructive cleanup requires explicit approval and is classified as roll-forward-only.

Never rename/drop a field in the same release that first introduces a reader/writer for the replacement.

## Deployment gate

A deployment is activated under a PostgreSQL advisory lock and advances `forge_release_state.epoch`. Workers register a fence record. A worker whose release identity or schema version is outside the active manifest compatibility window is marked `FENCED` and must not claim production work. The state `ROLL_FORWARD_REQUIRED` fences every worker until the recovery release is active.

Required operational phases are persisted in `forge_release_checkpoints`: `PREFLIGHT`, `MIGRATION`, `DEPLOY`, `POST_DEPLOY`, `ROLLBACK`, and `ROLL_FORWARD`.

## Feature flags

Flags are persisted in `forge_feature_flag_rollouts`. Rollback-sensitive flags must not be partially enabled: a flag marked `safeForRollback=false` can only be enabled at 100%. Use release bounds (`minReleaseId`/`maxReleaseId`) for compatibility-sensitive behavior.

## Rollback

Rollback is classified, never blindly executed:

- `SAFE_ROLLBACK`: no irreversible schema/provenance/accounting/approval/audit invariant was detected.
- `ROLL_FORWARD_REQUIRED`: destructive schema changes or immutable production invariants make rollback unsafe.

Immutable artifacts, provenance, usage/budget accounting, approvals and audit history are never deleted or rewritten as part of release recovery. If a deploy is interrupted, leave the release state and checkpoints intact, fence stale workers, and activate the next compatible release rather than attempting a destructive reverse migration.

## Post-deploy

Verify the active release ID, schema snapshot hash, worker admission and dependency readiness. `postDeploy` persists the schema hash and a pass/fail checkpoint. The schema snapshot covers public tables, columns, indexes and constraints, so drift is detectable without exposing credentials.

## CI

GitHub Actions runs the normal checks plus a disposable PostgreSQL 16 service, the full migration chain, release-safety integration tests, and the release preflight. The same commands can be run through RenderUtils CI before merge.
