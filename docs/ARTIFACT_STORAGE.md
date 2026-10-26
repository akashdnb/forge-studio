# Forge artifact storage

Forge treats generated media as immutable objects owned by the artifact/version graph. `storageUri` is descriptive metadata, not an authority for object lookup.

## Backends

Development/tests use the local filesystem backend. Production uses S3 or an S3-compatible object store (Cloudflare R2, MinIO, etc.).

```text
FORGE_STORAGE_DRIVER=local|s3
FORGE_STORAGE_MAX_BYTES=10737418240
FORGE_STORAGE_LOCAL_ROOT=.forge-storage

FORGE_STORAGE_S3_BUCKET=forge-artifacts
FORGE_STORAGE_S3_REGION=us-east-1
FORGE_STORAGE_S3_ENDPOINT=https://...
FORGE_STORAGE_S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

The AWS SDK also supports its standard credential-chain mechanisms; do not put credentials in artifact metadata or URLs.

## Object identity

Keys are derived only after the upload is streamed through a SHA-256 verifier:

`tenants/<tenant>/projects/<project>/artifacts/<kind>/<sha-prefix>/<sha256>.<extension>`

The artifact ID is intentionally not part of the content-addressed identity. The same immutable bytes can therefore be safely reused by multiple provenance records. Tenant/project/kind are server-derived and restricted to safe path segments.

## Upload contract

`ArtifactStorageService.putArtifact()` accepts a stream and enforces:

- bounded bytes (`FORGE_STORAGE_MAX_BYTES`);
- SHA-256 calculation and optional expected checksum verification;
- content type and bounded metadata;
- atomic local writes and idempotent content-addressed object creation;
- provenance validation against the episode/project/version graph;
- durable `storage_objects` reconciliation metadata.

Generated render, audio, image, caption and package artifacts use the same service. Provider-supplied filesystem paths or arbitrary URLs are never opened by Forge.

## Download contract

`openArtifact({ artifactId, projectId, expectedVersionId })` resolves the artifact through PostgreSQL and the trusted `storage_key`. It never parses or follows the caller-visible `storageUri`. The returned stream is verified against the persisted SHA-256 and bounded by the same size limit.

Missing objects are marked `MISSING`; checksum failures are marked `CORRUPT`. These conditions are explicit errors and must not be converted into successful workflow results.

## Recovery and idempotency

The object write is deliberately performed before database persistence so the database never points at a partially written object. If database persistence fails after a successful object write, the content-addressed object is safe to retry and can be reconciled later from its deterministic key. Database metadata records the trusted key, checksum, size and verification status.

Storage backends must remain immutable: callers cannot overwrite an existing content-addressed key with different bytes.
