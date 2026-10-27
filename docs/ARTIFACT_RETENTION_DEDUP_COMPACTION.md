# Artifact retention, deduplication and storage cost optimization

Forge keeps artifact/version identity immutable while allowing the physical bytes behind multiple tenant-owned artifacts to be shared safely. The content ledger is deliberately separate from `artifacts`: a content object is identified by `(tenant_id, sha256)` and carries exact byte count, checksum status, storage key, refcount and reservation count.

## Safety invariants

- Deduplication is tenant-scoped. Identical bytes in two tenants never share a content-ledger object.
- `artifacts`, versions and provenance evidence are never deleted by compaction.
- A physical object can be deleted only after a bounded reachability scan finds no live artifact references, no active reservation and no immutable-evidence/recovery protection.
- Ambiguous states (refcount mismatch, insufficient age, missing scope, or unexpected metadata) are quarantined/skipped, never deleted.
- Destructive `ENFORCE` plans require explicit operator approval and retain a policy snapshot.
- Every destructive attempt creates a tombstone before the storage-provider delete. A failed provider call restores the object to `QUARANTINED`.
- Final deletion rechecks the object row under `FOR UPDATE`; a late reference or reservation therefore wins over deletion.
- Refcount changes are database-triggered and serialized with content-object locks. Refcount underflow is prevented with `GREATEST(..., 0)` and a locked state transition.
- Reservations are idempotent by tenant/idempotency key and increment/decrement the object reservation count transactionally.

## Reachability roots

The optimizer protects objects referenced by current/approved episode versions, approval decisions, passing/warning QA, queued/running jobs, publish/package state, the existing artifact lifecycle ledger, and active provenance evidence nodes. Recovery-required and immutable-evidence objects are explicit hard roots. The scan is tenant scoped and resumable by content-object ID.

## Execution modes

Create a dry-run first:

```bash
node scripts/artifact-gc.js plan --tenant TENANT_ID --mode DRY_RUN --actor operator
```

For destructive compaction:

```bash
node scripts/artifact-gc.js plan --tenant TENANT_ID --mode ENFORCE --actor operator
node scripts/artifact-gc.js approve --tenant TENANT_ID --plan PLAN_ID --actor owner
node scripts/artifact-gc.js report --tenant TENANT_ID --plan PLAN_ID
node scripts/artifact-gc.js compact --tenant TENANT_ID --plan PLAN_ID --max-deletes 25
```

The durable job kinds `workflow:artifact-retention` and `workflow:artifact-compaction` use the same production path. A plan action is bounded by `scanLimit`; compaction is bounded by `maxDeletes` and the plan's `maxDeleteBytes` budget. Re-running a plan resumes from its checkpoint rather than starting an unbounded scan.

## Configuration

`FORGE_ARTIFACT_GC_POLICY_JSON` is a JSON object containing:

```json
{
  "quarantineGraceMinutes": 1440,
  "minAgeMinutes": 1440,
  "scanLimit": 100,
  "maxDeleteBytes": 1073741824,
  "requireOperatorApproval": true
}
```

Production should keep operator approval enabled and start with a small delete budget. Storage-provider deletion is never performed from an HTTP request or an unbounded timer; it happens only from an approved durable compaction plan.

## Cost diagnostics

`artifact_gc_plans.bytes_reclaimable` is the exact byte total for eligible content objects. `bytes_deleted` records actual provider deletions. Because every content object has a verified byte count, operators can compare logical artifact bytes with physical bytes and quantify dedup savings without estimating from object counts.

Recommended diagnostics:

```sql
SELECT tenant_id,
       count(*) AS objects,
       coalesce(sum(size_bytes),0) AS physical_bytes,
       coalesce(sum(CASE WHEN ref_count > 1 THEN size_bytes * (ref_count - 1) ELSE 0 END),0) AS logical_duplicate_bytes
FROM artifact_content_objects
WHERE status <> 'DELETED'
GROUP BY tenant_id;

SELECT status, count(*), coalesce(sum(size_bytes),0)
FROM artifact_content_objects
GROUP BY status
ORDER BY status;
```

## Crash/recovery runbook

1. Stop destructive compaction if provider errors or checksum anomalies appear.
2. Cancel the active plan; cancellation is durable.
3. Inspect `artifact_gc_plans.report`, `artifact_gc_items` and `artifact_storage_tombstones`.
4. Any `TOMBSTONED` object without a `DELETED` tombstone is treated as quarantined during reconciliation; do not manually delete the provider object.
5. Re-run a dry-run after the storage/recovery incident is resolved.
6. Verify recovery points before approving a new destructive plan.

The existing media reconciliation worker remains responsible for detecting missing/corrupt storage. This optimizer never replaces an immutable artifact in place.

## Metrics

The artifact storage path exposes existing I/O metrics; this subsystem adds `forge_artifact_dedup_registrations_total` with `created`/`deduplicated` outcomes. Operational dashboards should additionally derive plan counters from `artifact_gc_plans`: scanned, protected, ambiguous, reclaimable bytes and deleted bytes. Alert on ambiguous candidates, checksum metadata mismatches, repeated tombstone cancellation, or sustained `bytes_reclaimable` growth.

## Validation

Run:

```bash
npm run check
npm test
FORGE_RUN_ARTIFACT_GC_INTEGRATION=true node --test test/artifact-retention-optimizer.integration.test.js
```

The integration suite uses the real PostgreSQL schema and real local artifact storage; it covers duplicate uploads, tenant isolation, checksum mismatch, idempotent concurrent reservations, late references racing compaction, recovery-required protection and bounded GC planning.
