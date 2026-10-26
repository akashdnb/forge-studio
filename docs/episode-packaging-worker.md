# Episode Packaging Worker

`workflow:package` is the immutable boundary between final-media QA/approval and publishing.

The worker accepts only the current approved render, its exact immutable render version, passing QA for that artifact/version, and final-render approval. If approval evidence contains `metadataHash`, it must match the canonical SHA-256 of `episode.metadata`. Source media, approvals, QA and metadata are never mutated.

It re-verifies the stored checksum, validates MP4/video container metadata, dimensions and positive duration, and rejects missing/corrupt artifacts, stale gates, provenance mismatches and unsupported media.

## Canonical package

The package is an immutable `package` artifact containing a deterministic JSON manifest with episode identity, approved metadata, final-media artifact/version/checksum/size/media characteristics, QA evidence, approval identity and provenance. Identity is content-addressed:

- artifact: `episode-package:<manifest-sha256>`
- version: `package:<manifest-sha256>`
- source MP4 is referenced, never copied or modified

`episode_packages` enforces one logical package per episode and manifest hash.

## Reliability

Identical approved inputs produce identical package identity. Retries reconcile an existing package before creating another. A storage upload followed by database failure is surfaced as retryable `PARTIAL_OUTPUT`; retrying uses the same content-addressed object and artifact identity. Cancellation is terminal; media inspection is bounded by a timeout and media/manifest sizes are bounded.

Configuration: `FORGE_PACKAGE_MAX_MEDIA_BYTES` (20 GiB default), `FORGE_PACKAGE_MAX_MANIFEST_BYTES` (256 KiB default), `FORGE_PACKAGE_TIMEOUT_MS` (5 minutes default), and optional `FORGE_FFPROBE_COMMAND`.

## YouTube handoff

YouTube publishing requires `publish_runs.package_artifact_id` and `package_version_id`. It resolves the final MP4 only through the canonical `episode_packages` record, so a render-only publish request cannot bypass packaging.

Run `npm run migrate`, then `npm run check` and `npm test`.
