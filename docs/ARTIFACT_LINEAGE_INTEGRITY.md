# Durable artifact lineage and integrity control plane

Forge now treats the logical artifact graph and the physical content store as separate immutable layers with a database-enforced boundary between them.

## Guarantees

- Every stored artifact remains immutable; retries reuse the same content-addressed bytes and never replace a version in place.
- Physical content remains tenant-scoped and content-addressed. Existing `artifact_content_objects` / `artifact_content_refs` continue to own deduplication, refcounts, reservations and GC safety.
- `artifact_lineage_edges` records explicit parent/derived relationships with the child and parent version identities plus an evidence digest.
- PostgreSQL rejects lineage that crosses tenant, project or episode scope, mismatches artifact/version identity, or introduces a cycle.
- Real artifact publication resolves the project tenant before storage upload and records lineage for every input version that resolves to a parent artifact.
- Reads continue to verify SHA-256 through the storage adapter. A missing or mismatched object is marked unavailable/corrupt and is never silently replaced.
- Integrity scans are bounded, tenant-scoped and durable. Corrupt/missing objects are quarantined before any repair action.
- Ledger repair can rebuild a missing immutable content reference only after the artifact's physical bytes and checksum have been verified. Recovery restores remain the authoritative path for missing/corrupt bytes.

## Operator API

All endpoints require authenticated tenant context and OWNER role:

- `GET /v1/artifacts/integrity/health`
- `POST /v1/artifacts/integrity/scan` with `{ "projectId": "optional", "limit": 100 }`
- `POST /v1/artifacts/integrity/repair` with `{ "projectId", "artifactId", "action": "RETRY_VERIFY|REBUILD_LEDGER_REF|REBUILD_STORAGE_METADATA|RESTORE_FROM_RECOVERY|QUARANTINE" }`
- `POST /v1/artifacts/integrity/rebuild-ref` with `{ "artifactId": "..." }`

The scan records `artifact_integrity_runs` and `artifact_integrity_findings`. Repair requests are durable `artifact_integrity_repairs` records and can be dispatched as `workflow:artifact-integrity-scan` / `workflow:artifact-integrity-rebuild` jobs.

## Producer integration

`ArtifactStorageService.putArtifact()` is the common binary publication path used by render, narration, transcription, media and provider-backed artifact producers. It now:

1. resolves and verifies the project's tenant;
2. writes through the existing checksum-verifying content-addressed storage adapter;
3. atomically publishes trusted `storage_objects` metadata;
4. records immutable artifact parent relationships from `inputVersionIds`; and
5. continues to capture the existing provenance evidence chain.

A duplicate delivery with the same immutable artifact identity does not create a second logical artifact. Content deduplication remains tenant scoped and GC/lifecycle controls remain authoritative for physical deletion.

## Repair / incident runbook

1. Stop destructive GC if integrity findings increase unexpectedly.
2. Run a bounded integrity scan for the affected tenant/project.
3. Leave `MISSING`, `CORRUPT` and metadata-mismatch findings quarantined.
4. For an intact object whose ledger reference is missing, use `REBUILD_LEDGER_REF` / `rebuild-ref`.
5. For missing or corrupt bytes, restore from the existing isolated recovery system; do not upload replacement bytes under the old artifact identity.
6. Re-run the integrity scan and confirm the checksum, size, lineage and tenant/project scope.
7. Resume GC only after the scan is clean and the repair evidence is durable.

## Concurrency and crash safety

The lineage table has a uniqueness fence on `(child_artifact_id,parent_artifact_id,relation)` and a PostgreSQL trigger for scope/version/cycle validation, so concurrent producers converge on one edge. Integrity scans use a tenant/project advisory lock and bounded batches. GC continues to use the existing leases, quarantine, generation fencing and final reference checks; this feature never bypasses those deletion boundaries.

## Validation

```bash
npm run check
npm test
FORGE_RUN_ARTIFACT_INTEGRITY_INTEGRATION=true DATABASE_URL='postgres://...' node --test test/artifact-lineage-integrity.test.js
```

Apply the schema only through `npm run migrate`; migration `149_durable_artifact_lineage_integrity.sql` is transactional and participates in the repository's migration checksum/order preflight.
