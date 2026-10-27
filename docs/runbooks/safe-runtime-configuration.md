# Safe Runtime Configuration, Change Management and Rollout

## Scope

Forge Studio now has a durable configuration control plane layered beside the existing runtime-policy, credential, entitlement, circuit-breaker, scheduler and release-safety systems. It is not a replacement for those controls: it supplies immutable configuration revisions, deterministic effective-value resolution, staged activation, cohort rollout, fencing and rollback metadata.

## Configuration lifecycle

1. **Register schema** — define `config_key`, typed value rules, owner and whether the key is secret.
2. **Create revision** — writes an immutable DRAFT revision. The expected head revision is checked under a PostgreSQL advisory lock.
3. **Publish** — validates prerequisites and moves DRAFT to STAGED.
4. **Activate** — increments the scope generation/fence epoch transactionally and creates a rollout record. Partial rollouts retain the previous ACTIVE revision so non-cohort traffic safely falls back.
5. **Observe** — record health samples against the rollout. Error-rate and latency thresholds can trigger automatic rollback.
6. **Pause/resume** — operator control changes rollout state without rewriting the revision.
7. **Rollback** — swaps the head back to the recorded previous revision only when the rollout fence still matches; a stale operator cannot roll back a newer rollout.
8. **Kill switch** — emergency scope-local disable increments generation/fence epoch and causes resolution to fail closed for that scope.

## Scope precedence

Effective resolution is deterministic and ordered from least to most specific:

`GLOBAL -> PROVIDER -> TENANT -> PROJECT -> WORKFLOW`

A higher-precedence revision only wins for requests in its deterministic rollout cohort. If it is outside the cohort, the resolver continues to the lower-precedence active revision. Cohort selection hashes the stable configuration seed plus tenant/project/workflow/actor identity, so every process makes the same decision.

## Secrets

Secret material is never accepted as a normal configuration value. Keys that look secret-like must use `secret-ref`, and audit/evidence metadata is redacted before persistence. Existing `runtime_secrets` and `SecretCipher` remain the source of truth for secret material.

## Runtime fencing

Each activation increments a durable generation and fence epoch. Workers/runners should record their observed generation through `forge_runtime_config_consumer_fences`; stale consumers are marked `STALE` and must re-resolve before continuing. Long-running jobs must keep their existing runtime snapshot semantics; a configuration change must not mutate already-created artifacts or credentials. Side effects remain governed by their existing idempotency, lease, release-safety and compensation controls.

## Operator API

The server exposes the `/v1/runtime-config` control surface for schema registration, revision creation, publish/activate, effective resolution, rollout pause/resume/rollback, health samples and emergency kill switches. Mutating operator actions require OWNER/static operator authorization; tenant/project scoped writes are tenant-bound.

## Failure handling

- **Concurrent edit:** `CONFIG_CONFLICT` (HTTP 409); reread the current head and create a new revision.
- **Stale rollout operator:** `STALE_CONFIG_FENCE`; do not retry the stale mutation blindly.
- **DB/process crash:** activation and head changes are one PostgreSQL transaction; either both commit or neither does.
- **Stale cache:** runtime resolution is database-backed and bootstrap invalidates the local cache on control-plane mutation.
- **Deploy skew:** configuration generation/fence is independent of application release fencing, so both controls can reject stale workers.
- **Partial rollout:** previous revision remains active until rollout reaches 100%.
- **Post-side-effect rollback:** rollback changes future admission/config resolution; it does not attempt to undo external side effects. Existing publish/provider idempotency, reconciliation and compensation paths remain authoritative.

## Health regression procedure

1. Inspect rollout status and recent health samples.
2. If automatic rollback has not fired, pause the rollout.
3. Verify the active head and fence epoch.
4. Roll back using the rollout ID.
5. Investigate the failed revision; never edit an existing revision in place.
6. Create a new corrective revision and repeat staged rollout.

## Emergency procedure

Use the scope-local kill switch when a configuration must stop taking effect immediately. The kill switch increments the fence epoch and resolution fails closed for that key/scope. After containment, disable the switch only after an operator review and create a durable corrective revision.

## Migration / replay

Migration `161_safe_runtime_configuration_rollout.sql` is additive and compatible with the existing migration runner. Export/import tooling should preserve revision IDs, schema fingerprints, rollout metadata and audit/evidence references. Secret values must never be exported; only secret references and metadata are portable.
