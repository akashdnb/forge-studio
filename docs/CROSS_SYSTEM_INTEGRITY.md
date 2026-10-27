# Cross-System Data Integrity, Reconciliation and Consistency Verification

## Purpose

The cross-system integrity subsystem verifies the durable relationships between PostgreSQL, content-addressed artifact storage, provenance/evidence, jobs and leases, multi-destination publish receipts, usage accounting, tenant/project ownership, recovery metadata and runner callbacks. It is deliberately fail-closed: immutable artifacts, versions, receipts, usage events and audit evidence are never rewritten to make a scan pass.

## Durable model

Migration `100_cross_system_integrity.sql` adds:

- `forge_integrity_runs`: resumable scan state, bounded counters and schema fingerprint;
- `forge_integrity_records`: deterministic canonical snapshots and SHA-256 checksums per domain/entity;
- `forge_integrity_findings`: stable fingerprints, severity, repair safety and evidence;
- `forge_integrity_quarantine`: explicit diagnostic/quarantine state;
- `forge_integrity_repairs`: operator approval, deterministic plan fingerprint and before/after evidence.

A finding fingerprint is independent of the run id. Repeated scans therefore converge on the same finding instead of creating duplicate incidents.

## Domains

The scanner covers schema/migration shape, artifacts and storage checksums, provenance links, job state and leases, publish receipt ownership, usage reservation drift, tenant/project ownership, recovery checksums and runner callback consistency. Optional tables are discovered with `to_regclass` so a partially migrated environment is reported rather than silently assumed healthy.

## Scan safety

- PostgreSQL advisory locking prevents concurrent global scans.
- Each domain uses keyset pagination and persists its cursor after every page.
- Page size and storage-check concurrency are bounded by configuration.
- Storage verification uses the trusted storage adapter and expected SHA-256.
- A cancellation or process crash leaves the run resumable; immutable source rows remain untouched.
- Schema drift is a finding, never an automatic migration.

Configuration:

```text
FORGE_INTEGRITY_PAGE_SIZE=50
FORGE_INTEGRITY_CONCURRENCY=4
FORGE_INTEGRITY_WORKER_ID=forge-integrity-<worker>
```

## Repair safety

Repair is a separate operator action. `buildRepairPlan(runId)` emits deterministic plans with a plan fingerprint. `applyRepairPlan` requires both an approval identity and approval token and rechecks the finding fingerprint before executing.

Only these actions are automatically classified `SAFE`:

- `RECOVER_STALE_LEASE`: requeue a running job only when the lease is still expired and the job has no terminal timestamp. The SQL predicate makes the operation race-safe.
- `MARK_STORAGE_STATE`: mark a mutable `storage_objects` metadata row `MISSING` or `CORRUPT` after a failed trusted storage verification.
- `QUARANTINE_FINDING`: create diagnostic quarantine state without modifying immutable history.

Tenant mismatches, provenance breaks, duplicate/conflicting external receipts, usage drift, impossible transitions, migration drift and recovery inconsistencies remain review/unsafe. They require a new domain-specific repair workflow rather than a generic mutating reconciliation.

## CLI

```text
node scripts/reconcile-integrity.js scan
FORGE_INTEGRITY_RUN_ID=<run-id> node scripts/reconcile-integrity.js scan
node scripts/reconcile-integrity.js plan <run-id> > integrity-plan.json
FORGE_INTEGRITY_APPROVED_BY=<operator> \
FORGE_INTEGRITY_APPROVAL_TOKEN=<single-use-token> \
node scripts/reconcile-integrity.js apply integrity-plan.json
```

The plan file is evidence: do not hand-edit it. The apply path rejects a changed fingerprint, stale finding, unsafe action or missing operator approval.

## Worker integration

`createIntegrityHandlers()` exposes `system:integrity-reconcile` and `workflow:integrity-reconcile` for the durable job system. This keeps scheduled/on-demand reconciliation inside the same lease, retry and usage-governance boundary as other Forge work.

## Metrics and incidents

The integration is designed to emit bounded domain/outcome metrics through the existing observability object. Recommended alerts are:

- open critical integrity findings;
- repeated `QUARANTINED` runs;
- scan age beyond the configured SLO;
- stale lease findings;
- storage checksum/missing-object findings;
- publish receipt tenant conflicts;
- usage drift;
- recovery checksum mismatch;
- schema fingerprint changes outside a release window.

Diagnostic payloads must contain identifiers, checksums and provider-safe metadata only; never secrets or raw media.

## Disaster recovery and lifecycle

After a restore/import, run a new integrity scan before enabling publication or destructive lifecycle work. A partial restore should produce missing-reference findings and remain quarantined until the operator verifies the recovery point. Tenant/project deletion must not bypass an open integrity quarantine; lifecycle workers should use the same finding/quarantine evidence before deleting storage objects.

Artifact optimization and deduplication may only operate on content-addressed objects that have a healthy integrity record. Immutable duplicates are diagnosed through fingerprints/tombstones rather than silently deleting the canonical history.

## Verification

Run:

```text
npm run check
npm test
node --test test/cross-system-integrity.test.js
npm run migrate
```

For PostgreSQL/storage failure-injection coverage, configure `DATABASE_URL` against a disposable database. The integration test exercises the real migration ledger and scan path; the storage fixture injects missing-object failures without touching production storage.

## Operational runbook

1. **Scan**: run `scan` and capture the returned run id.
2. **Inspect**: generate a deterministic plan; sort/order is stable by domain/entity/code.
3. **Quarantine**: keep `CRITICAL` and unsafe findings quarantined.
4. **Approve only safe repairs**: validate the exact before-state and release epoch before approving.
5. **Apply**: use the generated plan and approval token; never issue ad-hoc SQL against immutable history.
6. **Rescan**: resume the same run for pagination or start a fresh run for post-repair verification.
7. **Close incident**: only close the operational incident after the rescan is clean and recovery/publish gates are healthy.

## Failure modes

- **Concurrent scan**: one scanner wins the advisory lock; another exits without mutating state.
- **Worker crash**: run cursor and findings already committed remain durable; resume with the run id.
- **Stale worker race**: repair uses an expiry predicate and terminal-state guard, so a renewed worker lease prevents requeue.
- **Duplicate callback/receipt**: existing unique destination/external identity constraints remain authoritative; reconciliation reports conflicts rather than reassigning receipts.
- **Missing object**: storage metadata is diagnosed/marked mutable `MISSING`; immutable artifact identity remains intact.
- **Tenant isolation failure**: reported as critical and never repaired by generic reconciliation.
- **Partial restore**: recovery/provenance findings force quarantine until an operator verifies the restored boundary.
