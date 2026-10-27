# Safe Runtime Configuration, Change Management and Rollout

Forge Studio now has a durable configuration control plane layered beside the existing runtime-policy, credential, entitlement, circuit-breaker, scheduler and release-safety systems. It supplies immutable revisions, deterministic effective-value resolution, staged activation, cohort rollout, fencing and rollback metadata without replacing those controls.

## Lifecycle
1. Register a typed schema and owner.
2. Create an immutable DRAFT revision with an optimistic expected revision.
3. Publish after prerequisite validation.
4. Activate transactionally; partial rollout retains the previous ACTIVE revision.
5. Observe health samples; threshold regressions auto-rollback.
6. Pause/resume rollout as an operator action.
7. Roll back only when the rollout fence still matches.
8. Use the scope-local kill switch for emergency containment.

Effective precedence is `GLOBAL -> PROVIDER -> TENANT -> PROJECT -> WORKFLOW`. Cohort selection hashes a stable seed with tenant/project/workflow/actor identity, so all runtimes make the same decision.

Secret-like keys must use `secret-ref`; material is never persisted or logged by this subsystem. Existing credential/secret stores remain authoritative.

Every activation increments generation and fence epoch. Workers record observed fences and stale consumers are rejected before continuing. Existing idempotency, leases, release safety, reconciliation and compensation remain authoritative for external side effects.

The `/v1/runtime-config` operator API supports schema registration, revision creation, publish/activate, resolution, rollout pause/resume/rollback, health samples and emergency kill switches. Tenant/project writes are tenant-bound; operator/global mutations require owner/static authorization.

Failure handling: concurrent edits return `CONFIG_CONFLICT`; stale rollout operators return `STALE_CONFIG_FENCE`; activation/head changes are one PostgreSQL transaction; partial rollouts preserve the previous revision; rollback changes future admission/resolution and does not attempt to reverse already committed external side effects.

Migration `161_safe_runtime_configuration_rollout.sql` is additive. Revision import is idempotent and fingerprint-checked; secret material is never exported.
