# Release and Deployment Safety

Forge treats a production release as a durable, versioned control-plane object rather than a deploy checklist.

## Release manifest

Each release manifest records the application commit/version, schema compatibility window, exact migration names/checksums and destructive classification, worker versions/contracts, protocol versions, runtime/config snapshot identity, feature-flag rollout policy, required indexes/configuration, health policy, and rollback policy. The manifest hash is evidence-bound and is never used to rewrite immutable episode/version/artifact/provenance history.

## Gate sequence

1. **Plan** — persist the release manifest and migration/schema evidence.
2. **Preflight** — fail closed on migration checksum drift, migration-set drift, schema drift, unsafe active workload, incompatible workers, stale public-runner executions, unsafe feature-flag rollout, or recovery-blocked state.
3. **Approval** — requires durable QA, health and rollback-plan evidence.
4. **Activate** — takes the deployment advisory lock, increments the release epoch, records a recovery checkpoint, drains old workers, and binds new jobs to the active release epoch.
5. **Health verification** — checks schema identity, worker compatibility, active release state and public-runner expiry. Failure transitions the release to `ROLL_FORWARD_REQUIRED` instead of guessing a rollback.
6. **Recovery** — rollback is allowed only when the migration/provenance policy proves it is safe. Otherwise the system explicitly requires roll-forward.

## Database safety

Migration 025 adds durable deployment checks, release audit history, recovery checkpoints, a migration lock, job release/schema/protocol requirements and execution release epochs. Database triggers fence incompatible job claims and prevent unsafe release migrations from entering `DEPLOYING` while active workloads exist.

Migration gaps, duplicate/changed checksums and schema drift are evidence, not warnings. Production activation must stop until they are resolved.

## Worker and public runner fencing

Workers are admitted to the current release epoch and schema/protocol compatibility window before they can consume jobs. Public Forge runner executions carry a release epoch in durable execution state; reconciliation and callbacks reject executions from older epochs so stale work cannot mutate a newer release.

## Control-plane endpoints

All release endpoints require an authenticated OWNER:

- `POST /v1/ops/releases/plan`
- `POST /v1/ops/releases/:releaseId/preflight`
- `POST /v1/ops/releases/:releaseId/approve`
- `POST /v1/ops/releases/:releaseId/activate`
- `GET /v1/ops/releases/:releaseId/health`
- `POST /v1/ops/releases/:releaseId/health`
- `POST /v1/ops/releases/:releaseId/rollback`
- `GET /v1/ops/releases/health`
- `GET /v1/ops/releases/diagnostics`

## Metrics and diagnostics

The release health/diagnostics payloads expose the active epoch, active workload count, worker admission state, stale public-runner count, failed deployment checks and recent release state. These are intended to be scraped or bridged by the existing Operations Control Plane and incident detector.

## Recovery invariants

Rollback never deletes, mutates or re-identifies immutable artifacts, provenance, approvals, QA evidence, usage/budget accounting or audit history. A release with destructive/irreversible schema changes is `ROLL_FORWARD_REQUIRED`.
