# Deterministic Timeline Manifest Worker

The timeline-manifest worker is the single compiler boundary between approved editorial state and FFmpeg rendering. The compiler never mutates the persisted timeline object; render-source enrichment happens on a detached copy.

## Contract

Job kind: `workflow:timeline-manifest`

Payload:

```json
{
  "episodeId": "episode-123",
  "timelineVersionId": "timeline-version-7",
  "inputVersionIds": ["asset-version-1", "narration-version-2"],
  "actor": "worker"
}
```

The timeline version must be immutable, hash-consistent, approved, and must declare every referenced immutable input through `version_dependencies`. The compiler rejects malformed ordering, overlaps, duration mismatches, missing assets, unsupported provenance, missing source paths, and narration alignment conflicts. It never silently repairs an input.

## Determinism

Compiler version is `forge-timeline-manifest-v1`. Canonical JSON uses recursively sorted object keys and preserves array order. The manifest checksum is SHA-256 over the canonical manifest body excluding `manifestChecksum`; the stored artifact checksum is SHA-256 over the exact UTF-8 manifest bytes including the trailing newline. Re-running the same immutable inputs with the same compiler/configuration therefore produces byte-for-byte identical content and checksums.

## Artifact and provenance

The worker persists an immutable `render-manifest` version and content-addressed artifact. Metadata records compiler version, timeline version/hash, input version IDs, duration, stream expectations, render parameters, and both manifest/artifact checksums. The artifact identity is derived from the manifest checksum, making retries idempotent. A conflicting existing identity is a terminal provenance failure.

## FFmpeg boundary

`workflow:render` requires `manifestArtifactId`. It downloads and verifies the immutable manifest, validates `manifestChecksum`, and passes the manifest directly to the FFmpeg renderer. The renderer no longer reconstructs timeline state from episode snapshots or arbitrary timeline payloads. Render output provenance points back to the manifest version and its immutable input versions.

## Bounded execution and failure behavior

Input payloads are capped at 2 MiB and the compiler caps a timeline at 32 tracks and 5,000 segments. Terminal validation/provenance errors are marked non-retryable; storage/network failures retain normal job retry semantics. Job leases and heartbeats remain owned by the existing durable `JobQueue` lifecycle. Cancellation is safe because no mutable timeline state is written and artifact publication occurs only after all validation and compilation succeeds.
