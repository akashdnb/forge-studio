# Tenant Plan, Feature Entitlement and Capability Limits

Forge evaluates tenant commercial capability at the server-side control plane. A plan is immutable by version; tenant assignments are durable effective-time records; overrides and kill switches are separately auditable. No request, worker, provider, runner, storage or publishing path may infer entitlement from client state.

## Precedence

1. Tenant lifecycle: suspended/deleted/held tenants are denied.
2. Feature kill switch: an explicit disabled switch wins over every plan/override.
3. Historical plan assignment: the version effective at the operation snapshot time is selected by `(effective_at, epoch)`.
4. Tenant override: an unexpired, non-revoked controlled/emergency exception overrides the plan capability/limit.
5. Plan entitlement: missing capability, disabled capability, or a DENY limit fails closed.
6. Reservation: PostgreSQL advisory locking serializes consumption for `(tenant, capability)` and reserves before work starts.

The evaluator is deny-by-default when a capability is absent. Compatibility migration `153_tenant_plan_entitlements.sql` seeds a legacy plan with the existing quota baseline and assigns it to pre-existing tenants, so enabling the subsystem does not unexpectedly stop current production workloads.

## Historical work

Every entitlement reservation records the exact `plan_version_id`, assignment and epoch used to admit the operation. Durable jobs also receive a redacted entitlement snapshot in job metadata. Retries and worker claims use the job creation snapshot, not the latest plan, so a downgrade cannot rewrite the semantics of already-admitted work. Kill switches and tenant lifecycle blocks remain live safety fences.

## Real enforcement boundaries

- HTTP: capability derived from the authenticated tenant and route class; publishing, export/import, credential, runner, workflow and artifact operations are explicitly mapped.
- Durable jobs: reservation occurs before enqueue and historical snapshot is revalidated at claim.
- Provider execution: provider reservation precedes the real provider reliability execution.
- Artifact storage: artifact writes reserve `artifact_storage` before persistence.
- Publishing/export/runner: their durable jobs and HTTP boundaries map to dedicated capabilities rather than inheriting generic API access.
- Usage: settled entitlement reservations create a tenant-scoped immutable usage ledger with the plan version that admitted the work.

Existing quota/cost/capacity controls remain authoritative alongside entitlements. A reservation must pass both governance layers; neither can be bypassed by retries or duplicate callbacks.

## Operator API

All routes are authenticated OWNER-only and tenant scoped:

- `POST /internal/entitlements/plans` — create an immutable plan plus draft version/entitlement matrix.
- `POST /internal/entitlements/activate` — activate a plan version; activation never rewrites prior versions.
- `POST /internal/entitlements/assign` — activate now or schedule a future tenant assignment with optional grace period and grandfathering.
- `GET /internal/entitlements/inspect` — inspect the effective plan/capability matrix.
- `POST /internal/entitlements/explain` — deterministic allow/deny explanation for a capability and quantity.
- `POST /internal/entitlements/override` — create a time-bounded controlled/emergency tenant exception.
- `POST /internal/entitlements/kill-switch` — change a feature kill switch and advance its epoch.
- `GET /internal/entitlements/diagnostics` — reservation/cache diagnostics.

Plan rollback is performed by assigning an already-created immutable plan version; no historical row is rewritten or deleted.

## Scheduling, downgrade and grace

A scheduled assignment is selected only after its PostgreSQL `effective_at`. A grace period is persisted with the assignment and plan limits can additionally use `GRACE` overage policy. Grandfathering is represented on the assignment and concretely realized by snapshotting the version into every admitted reservation/job. Downgrades therefore affect new work without mutating admitted work.

## Concurrency and failure safety

- Tenant/capability consumption uses PostgreSQL advisory transaction locks.
- Reservation identity is idempotent and conflicts fail closed.
- Usage is inserted from the same immutable reservation identity and cannot double-count retries.
- Cache entries are short-lived and invalidated across processes with PostgreSQL `NOTIFY`.
- Deleted tenants are protected by foreign keys; cross-tenant project reservations are rejected by a database trigger.
- Multi-region/stale-worker fencing remains handled by the existing routing/lease control plane; entitlement snapshots do not grant a stale worker permission to mutate a fenced job.

## Failure injection / operations

If entitlement storage is unavailable, sensitive production paths must fail closed rather than silently bypassing a plan. If a reservation is `HELD` after a worker crash, existing lease/reconciliation tooling should settle or release it; never delete it manually. If a plan change appears stale, inspect the reservation's `plan_version_id` and epoch before retrying.

Recommended alerts:

- sustained `ENTITLEMENT_LIMIT_EXCEEDED` responses;
- held reservations older than the configured TTL;
- cache invalidation/notification failures;
- unexpected entitlement usage growth;
- kill switches active beyond the incident window;
- scheduled assignments that remain pending after their effective time.

## Validation

```bash
npm run migrate
npm run check
npm test
DATABASE_URL=... node --test test/tenant-plan-entitlements.test.js
```

The PostgreSQL test covers real tenant isolation, immutable plan versions, future effective versions, limit reservations, idempotent state and a concurrent race where exactly one of two consumers can claim a one-unit limit.
