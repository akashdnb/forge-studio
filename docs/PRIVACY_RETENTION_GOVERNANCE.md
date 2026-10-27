# Privacy, retention, legal hold and sensitive-data governance

Forge privacy enforcement is durable and tenant-scoped. It is not a documentation-only policy layer.

## Data classes

Every tenant gets explicit classifications for audit evidence, provenance, artifacts, job logs, event payloads, provider payloads, webhook envelopes, publish metadata, reviews/comments and backups. Additional durable tables with proven `tenant_id`/`project_id` ownership are evaluated as `derived_records` using the tenant default policy.

`RESTRICTED` and `SENSITIVE` payloads are encrypted before quarantine. Sensitive field names are recursively redacted from quarantine/export representations. Public runner manifests must use `sanitizeRunnerManifest`; provider payloads are removed unless an evidence reference explicitly requires a field.

## Immutable evidence

Audit evidence, provenance and backup protection records are explicitly immutable. Retention can never delete them. A policy snapshot records the exact policy version/fingerprint used by a run, so later policy changes do not change the meaning of an existing decision.

## Retention protocol

1. `npm run privacy:enqueue` creates one idempotent durable scan job per live tenant and an execution job dependent on that scan.
2. `privacy:retention-scan` snapshots the tenant policy and inventories only tables whose ownership can be proven. It persists deterministic item IDs, eligibility timestamps, hold IDs, policy fingerprint and decision evidence.
3. Eligibility is deterministic: `observed_at + retention_days`, followed by a grace period. Immutable evidence is preserved; active legal holds block destructive decisions.
4. Destructive execution requires an operator approval record for the exact sorted item fingerprint. The worker re-checks holds after claiming each item.
5. Approved rows are copied into encrypted quarantine before deletion. Referential failures become durable `BLOCKED` decisions rather than partial deletes. Retries are safe and use row locks/`SKIP LOCKED`.
6. Every eligibility, hold block, quarantine and destruction decision is recorded in `privacy_decision_evidence`.

## Tenant deletion and holds

Lifecycle deletion workers are wrapped by `PrivacyGovernance.guardDestructiveAction`. A live privacy hold therefore blocks both lifecycle planning and execution even if a stale deletion request exists. Existing `lifecycle_holds` legal holds are synchronized into `privacy_holds` by a database trigger.

Never manually delete a tenant row, storage object, backup, audit row or provenance row to unblock a lifecycle request.

## Export / runner boundary

Exports should call `sanitizeExport` before serialization. Runner/public manifests should call `sanitizeRunnerManifest`. The sanitizer is deliberately field-name based and recursive; callers that need a specific evidence field must name it explicitly in `requiredEvidenceKeys`.

## Storage and recovery

Artifact storage rows are classified through `storage_objects` and project ownership. Quarantine is database-first; physical storage deletion must remain behind the existing Forge storage adapter. Backup rows are immutable by default and are never selected for destructive privacy execution.

## Operations

Required worker secret:

```text
FORGE_PRIVACY_ENCRYPTION_KEY=<32-byte base64 or 64-char hex key>
```

The existing `FORGE_SECRET_ENCRYPTION_KEY` is accepted as a fallback so production deployments can rotate without maintaining a second key immediately.

Useful commands:

```bash
npm run migrate
npm run privacy:enqueue
npm test -- test/privacy-governance.test.js
npm run check
```

Schedule `npm run privacy:enqueue` from the production scheduler (daily is the default recommendation). The command is idempotent per tenant/day. Retention jobs use the normal Forge queue leases, retries and crash recovery.

## Diagnostics / metrics

Operational evidence is persisted in `privacy_retention_runs`, `privacy_retention_items` and `privacy_decision_evidence`. Monitor:

- runs stuck in `RUNNING` beyond the worker lease/SLO;
- growth of `BLOCKED` items and active privacy holds;
- quarantine backlog and items past `quarantine_until`;
- referential delete failures;
- repeated retention scan failures;
- cross-tenant scope errors.

A worker readiness failure caused by a missing privacy encryption key is intentional fail-closed behavior. A missing storage adapter must never be replaced with direct object-store deletion.

## Recovery and replay

Policy snapshots make retention decisions replayable. Replaying an old run must use its recorded `policy_snapshot_id`; it must not silently re-evaluate under the current tenant policy. Recovery restores must preserve privacy tables and immutable evidence before any retention worker is resumed.

## Concurrency guarantees

- Policy versions serialize on the tenant row, preventing duplicate versions.
- Snapshot creation is idempotent by `(tenant, execution_kind, execution_id)`.
- Item creation is idempotent by `(tenant, resource_type, resource_id, policy_snapshot_id)`.
- Destructive execution uses `FOR UPDATE SKIP LOCKED` and re-checks holds after claiming.
- Approval fingerprints are stable because item IDs are sorted before hashing.
- A newly-created hold wins races against destruction because destruction checks the current hold set inside its transaction.
