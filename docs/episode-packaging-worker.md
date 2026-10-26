# Episode Packaging Worker

The packaging stage is the immutable boundary between final-media QA/approval and publishing. Job kind: `workflow:package`.

## Contract

The worker accepts only the episode's current approved render, its immutable render version, a passing QA result for that exact artifact/version, and the final-render approval. The approval evidence may carry `metadataHash`; when present it must equal the canonical SHA-256 of `episode.metadata`.

The worker never mutates the source render, QA result, approval, or episode metadata. It verifies the stored checksum again, inspects the MP4 container/video stream, dimensions and duration, and rejects unsupported media, missing/corrupt storage, stale gates, and provenance mismatches.

## Canonical package

A package is an immutable `package` artifact containing a deterministic JSON manifest. The manifest records the episode identity, approved metadata, final-media artifact/version/checksum/size/media characteristics, QA evidence, approval identity, and provenance links. The package artifact is content-addressed by the manifest SHA-256:

- artifact id: `episode-package:<manifest-sha256>`
- version id: `package:<manifest-sha256>`
- media is referenced, not copied or mutated

`episode_packages` is the durable logical-package index and has a uniqueness constraint on `(episode_id, manifest_hash)`.

## Idempotency and reconciliation

Identical approved inputs produce the same manifest and package identity. Retries first reconcile an existing logical package before creating another. A storage upload followed by database failure is surfaced as `PARTIAL_OUTPUT`/retryable; a later retry uses the same content-addressed package object and deterministic artifact id rather than creating a second logical package.

Cancellation is terminal and checked before provider/storage publication. Media inspection has a bounded timeout. Storage inspection is bounded by `FORGE_PACKAGE_MAX_MEDIA_BYTES` and manifest size by `FORGE_PACKAGE_MAX_MANIFEST_BYTES`.

Configuration:

- `FORGE_PACKAGE_MAX_MEDIA_BYTES` — maximum bytes read while verifying the final media artifact (default 20 GiB).
- `FORGE_PACKAGE_MAX_MANIFEST_BYTES` — maximum canonical manifest size (default 256 KiB).
- `FORGE_PACKAGE_TIMEOUT_MS` — overall packaging/inspection timeout budget (default 5 minutes).
- `FORGE_FFPROBE_COMMAND` — optional ffprobe executable override.

## Publishing handoff

YouTube publishing now requires `publish_runs.package_artifact_id` and `package_version_id`. It resolves the immutable final-media component only through the canonical `episode_packages` record and refuses legacy render-only publish runs. The package is therefore the sole publish boundary while the MP4 remains an immutable referenced component.

Run migrations with `npm run migrate`; validate with `npm run check` and `npm test`.
