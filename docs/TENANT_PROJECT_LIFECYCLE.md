# Tenant / project lifecycle, retention and secure deletion

Forge Studio now has an explicit lifecycle state machine and a durable, resumable deletion subsystem. Deletion is a two-step operation: request + explicit confirmation, followed by a dry-run/plan and bounded execution.

## States

`ACTIVE -> SUSPENDED -> ARCHIVED -> DELETION_REQUESTED -> DELETION_IN_PROGRESS -> DELETED` are normal lifecycle stages. `LEGAL_HOLD` and `SAFETY_HOLD` are blocking states; active holds are also persisted in `lifecycle_holds` so a hold can be attached to a whole tenant, one project, or an exception scope.

State changes require an actor, a reason, and optimistic revision when supplied. Cross-tenant project IDs fail closed. `forge_jobs` has a database trigger that rejects new jobs for non-ACTIVE projects or tenants carrying a legal/safety hold.

## Deletion protocol

1. Authenticate as an OWNER and resolve the target through the verified tenant identity. Never authorize by resource ID alone.
2. `requestDeletion` persists the target, actor, reason, idempotency key and a SHA-256 hash of a caller-supplied confirmation string. It moves the target to `DELETION_REQUESTED`.
3. `confirmDeletion` requires the same actor and confirmation string. There is no implicit confirmation from an HTTP method, UI click or job enqueue.
4. `plan` locks the request, checks holds, inventories active jobs, publishing, budget reservations, runner executions, exports/backups and every reachable PostgreSQL table that can be proven to belong to the tenant/project. Protected audit/evidence tables are never candidates.
5. Artifacts and storage objects are marked as quarantine work in the plan. Execution requires the configured Forge storage adapter; a missing adapter is a hard block, never a direct object-store deletion.
6. `execute` claims bounded plan items, re-checks scope, deletes only rows whose ownership is proven by tenant/project/episode/artifact/version/job reachability, records per-item status and can be safely rerun after a crash.
7. A request completes only after all plan items are terminal, no queued/running jobs remain, and the root lifecycle record can be safely finalized. Unknown dependencies remain blocked.

## Durable worker

`src/lifecycle/worker-handlers.js` provides:

- `lifecycle:plan-delete`
- `lifecycle:execute-delete`
- `lifecycle:reconcile`

The existing worker supports loading additional handlers through `FORGE_WORKER_HANDLERS`. A production worker should load a module exporting `handlers` from `createLifecycleHandlers({ pool, storage })`; this keeps deletion execution inside the same durable lease/retry boundary as the rest of Forge.

## Retention

`tenant_retention_policies` stores an immutable-by-revision policy document per tenant. A policy should include at least default, artifact, job and event retention windows. Retention is advisory until a planner proves ownership and eligibility; retention must never override a legal/safety hold or a published/audit preservation requirement.

## External references and storage

Storage keys are only obtained from trusted `storage_objects.storage_key` metadata. Caller-provided `storage_uri` values are not fetched. The executor uses the configured Forge storage driver's `delete()` operation and refuses to proceed if an external object exists but the storage adapter is unavailable.

Published history, audit events, security audit events, runtime configuration audit, runtime boot/worker snapshots and deletion evidence are preserved. Provider callbacks, runner attempts, exports, backups and budget reservations are treated as blockers until their durable state is terminal or their retention/ownership contract explicitly allows cleanup.

## Crash recovery and reconciliation

Execution is intentionally bounded. Each item is persisted as `PENDING`, `RUNNING`, `SUCCEEDED`, `BLOCKED` or `FAILED`. A process crash leaves the request resumable; the next worker run replans/reconciles before retrying. `lifecycle_reconciliation` records active work, holds, blocked deletion requests and future orphan/retention-drift counts.

Recommended operator cadence:

- alert on `DELETION_IN_PROGRESS` older than the configured SLO;
- alert on blocked requests and unknown external references;
- run lifecycle reconciliation after storage incidents, database restores and runner outages;
- never manually delete rows or storage keys to unblock a request;
- place an exception/hold on a request when a dependency is under investigation.

## Safety controls

- Tenant ID is mandatory for every lifecycle operation.
- Project IDs are checked against the tenant before any destructive query.
- Confirmation and request idempotency are persisted.
- Lifecycle transitions use row locks and revisions.
- Deletion is fail-closed for unknown scope, active work, holds and missing storage adapters.
- Destructive operations never target protected evidence tables.
- SQL identifiers come only from PostgreSQL metadata; resource IDs are always parameters.

## Metrics / health

The lifecycle reconciler persists the authoritative counts needed for operational metrics: active jobs, active holds, blocked requests, retention drift and future orphan scans. Expose these through the existing Forge observability layer when wiring the lifecycle handler into the API/worker deployment. The health contract is unhealthy when a deletion request is blocked by an unknown dependency or an external storage adapter cannot be proven available.

## Release checklist

1. Apply migration `022_tenant_project_lifecycle.sql` through the normal migration runner.
2. Configure the same artifact storage backend used by the production worker.
3. Load `createLifecycleHandlers` through the worker's handler extension point.
4. Verify OWNER-only access at the API boundary and cross-tenant negative tests.
5. Run a dry-run plan for a disposable tenant before enabling deletion execution.
6. Verify a legal/safety hold blocks both planning and execution.
7. Kill a worker between two deletion items and verify a second worker resumes safely.
8. Verify published/audit evidence remains after deletion.
9. Review deletion evidence before every production release that changes storage, jobs, runner execution, exports or retention policy.
