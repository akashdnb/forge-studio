# Artifact encryption, integrity and CAS lifecycle

Forge artifact bytes are immutable and content-addressed by a server-computed SHA-256 digest. Filenames, client storage URIs and arbitrary object metadata are never used as artifact identity.

## Guarantees

- Uploads are bounded and streamed through SHA-256 verification before a storage key is finalized.
- S3 production storage uses server-side encryption by default (`AES256`); `AWS_KMS` is available with `FORGE_STORAGE_S3_KMS_KEY_ID`.
- S3 writes include the SHA-256 transport checksum and use `IfNoneMatch: *`; a racing duplicate converges on the already finalized immutable object.
- PostgreSQL stores an authenticated immutable integrity manifest containing tenant/project/artifact/version identity, digest, exact byte size, MIME type, storage key and encryption metadata.
- Reads authenticate the manifest before opening bytes and then stream-verify the object against the persisted SHA-256. Metadata or byte corruption moves the storage record to `CORRUPT`/`MISSING` and never silently substitutes another object.
- Existing tenant-scoped content objects and active references remain authoritative for deduplication, retention and garbage collection. This feature never bypasses reference accounting or destructive GC fences.
- Recovery/repair is two-phase: verify real bytes first, then rebuild missing ledger references/manifests. Missing or corrupt bytes must come from the existing recovery/re-ingest workflow; an old artifact identity is never overwritten with replacement content.

## Operator workflow

1. Stop destructive compaction if integrity failures rise unexpectedly.
2. Run the bounded artifact integrity scan for the affected tenant/project.
3. Inspect `artifact_integrity_runs` and `artifact_integrity_findings`; corrupt objects remain quarantined.
4. For intact bytes with missing ledger/manifest metadata, request the existing `REBUILD_LEDGER_REF` repair; the durable worker also rebuilds the authenticated manifest.
5. For missing/corrupt bytes, restore/re-ingest through the existing immutable recovery path.
6. Re-run the scan and verify digest, size, encryption metadata, lineage and tenant scope.
7. Resume GC only after the scan is clean and repair evidence is durable.

## Diagnostics

Useful metrics include `forge_artifact_io_total`, `forge_artifact_bytes_total`, upload/download duration metrics and the existing artifact integrity scan counters. Alert on manifest authentication failures, encryption metadata mismatches, repeated `CORRUPT`/`MISSING` findings and growth in quarantined content.

## Configuration

Production S3 storage is encrypted by default. Set:

```text
FORGE_STORAGE_DRIVER=s3
FORGE_STORAGE_S3_ENCRYPTION_MODE=AES256
```

For customer-managed KMS keys:

```text
FORGE_STORAGE_S3_ENCRYPTION_MODE=AWS_KMS
FORGE_STORAGE_S3_KMS_KEY_ID=<kms-key-id>
```

Manifest authentication uses `FORGE_ARTIFACT_INTEGRITY_KEY` when present, otherwise the existing `FORGE_SECRET_ENCRYPTION_KEY`. Keep the secret stable across rolling deployments and do not persist it in artifact metadata.

## Validation

```bash
npm run check
npm test
FORGE_RUN_ARTIFACT_ENCRYPTION_INTEGRATION=true DATABASE_URL='postgres://...' npm test -- --test-name-pattern='postgres integration exposes tenant-safe manifest'
```

Apply migration `150_artifact_integrity_encryption_manifest.sql` only through `npm run migrate`; the repository migration preflight enforces ordering and checksums.
