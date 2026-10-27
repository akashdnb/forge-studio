# Release Rollback / Progressive Delivery Runbook

Forge progressive delivery is a durable control-plane boundary around the real publish worker. Release candidates capture immutable artifact/version ids, content hashes, provenance and manifest identity. Historical candidates and evidence are never rewritten.

## Sequence

1. Create the normal release manifest and pass existing release-safety/QA/approval gates.
2. Create a progressive plan with `POST /v1/ops/release-rollouts/plan`; stages must increase monotonically and end at 100%.
3. Run `dry-run`. Quarantined artifacts, missing checksums/provenance and invalid rollout plans block activation.
4. Approve each stage with durable operator/QA evidence.
5. Promote one stage at a time. PostgreSQL advisory locking serializes transitions and increments the deployment epoch.
6. Real publish jobs are gated by the immutable candidate and deterministic release/run cohort. A run cannot change cohorts after stage activation.
7. Record health per epoch/stage. Threshold failure automatically halts the release.
8. Provider callbacks carry the deployment epoch. Older epochs and terminal releases are fenced; duplicate callback ids are idempotent.
9. Rollback selects the latest immutable completed release for the same tenant/project, clones only a new publish-run snapshot, queues a real `publish:rollback` job and records the rollback target. The known-good release itself is never mutated.

## Operator APIs

- `POST /v1/ops/release-rollouts/plan`
- `GET /v1/ops/release-rollouts/:releaseId`
- `POST /v1/ops/release-rollouts/:releaseId/dry-run`
- `POST /v1/ops/release-rollouts/:releaseId/approve`
- `POST /v1/ops/release-rollouts/:releaseId/promote`
- `POST /v1/ops/release-rollouts/:releaseId/pause`
- `POST /v1/ops/release-rollouts/:releaseId/abort`
- `POST /v1/ops/release-rollouts/:releaseId/rollback`
- `POST /v1/ops/release-rollouts/:releaseId/health`
- `POST /v1/ops/release-rollouts/:releaseId/callback`

All operator endpoints require authenticated OWNER access and no-store responses.

## Failure / recovery rules

- Concurrent promotion/rollback: advisory lock per release.
- Duplicate callbacks: unique `(provider, callback_id)` plus idempotent replay.
- Stale workers/callbacks: deployment epoch fencing and terminal-state checks.
- Provider failure: durable publication failure plus automatic halt.
- Health regression: durable failed sample plus automatic halt.
- Artifact quarantine/deletion: dry-run checks the existing quarantine boundary; real publish still runs existing artifact/media/provenance gates.
- Restart/database partition: persisted plan state and epoch are authoritative; workers never use an in-memory rollout cursor.
- Rollback during promotion: the same lock serializes it; rollback increments the epoch, captures the known-good candidate and creates a new publish run without mutating the old run.

## Diagnostics

Inspect a release to view candidate provenance, stage state, approvals, health samples, provider publications and append-only events. Group `forge_release_provider_publications`, `forge_release_health_samples` and `forge_release_events` by tenant/project/release epoch for operational dashboards.
