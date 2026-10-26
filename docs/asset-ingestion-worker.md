# Asset Ingestion and Validation Worker

`workflow:assets` is Forge's bounded, immutable asset-ingestion stage. It accepts an approved immutable scene/scene-plan reference plus either an inline binary source or an existing trusted artifact reference. It never follows arbitrary provider URLs or mutates the source object.

## Contract

The job payload may contain:

- `episodeId` — required.
- `sourceVersionId` and/or `inputVersionIds` — immutable provenance inputs; these must belong to the same episode and be `scene-plan`, `scene`, or `asset` versions.
- `sourceArtifactId` — optional existing trusted artifact to read through the storage abstraction.
- `contentBase64` — optional configured/provider binary input. `content` is supported for controlled test/configuration inputs.
- `mediaType` — required and restricted to the configured image/audio/video types.
- `expectedSha256` / `contentHash` — optional but strongly recommended; the worker always computes the authoritative SHA-256.
- `sceneId`, `assetRole` — optional provenance selectors.

The worker validates byte size, SHA-256, media type, container, codec, dimensions and duration using bounded `ffprobe` execution. Images are validated as image streams, audio as audio streams and video as video streams. Unsupported/corrupt/oversized/stale or ambiguous inputs fail without creating a ready artifact.

## Immutability and idempotency

The immutable version and artifact IDs are content-addressed as `asset:<sha256>`. `asset_ingestions` additionally records the episode, source checksum and provenance fingerprint. A repeated delivery of the same bytes with the same provenance returns the existing logical artifact instead of creating another version.

Storage is written through the existing content-addressed artifact backend. The source is never replaced. If storage succeeds but database reconciliation is interrupted, the next attempt derives the same storage key and can reconcile the existing object into the durable artifact graph.

## Limits

```text
FORGE_ASSET_MAX_BYTES=1073741824
FORGE_ASSET_MAX_DURATION_SECONDS=3600
FORGE_ASSET_MAX_WIDTH=16384
FORGE_ASSET_MAX_HEIGHT=16384
FORGE_ASSET_VALIDATION_TIMEOUT_MS=120000
FORGE_ASSET_MAX_RETRIES=3
FORGE_FFPROBE_COMMAND=ffprobe
FORGE_ASSET_ALLOWED_CODECS=h264,hevc,vp9,av1,aac,mp3,opus,vorbis,flac,pcm_s16le
FORGE_ASSET_ALLOWED_CONTAINERS=mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,ogg,flac,image2
```

Keep the limits appropriate to the worker class. The storage backend has its own maximum object size and checksum enforcement; the ingestion limit should not exceed that backend limit.

## Failure and recovery

Permanent validation/provenance failures are non-retryable. Timeouts and transient execution failures are marked retryable and use Forge's existing leased durable job lifecycle. Cancellation is terminal. Worker heartbeats keep long-running validation jobs leased.

`asset_ingestions.status=PROCESSING` is deliberately safe to revisit. A subsequent retry either discovers the already-ready logical artifact or reconciles a content-addressed object that was persisted before the database transaction completed. No source object is deleted or rewritten by reconciliation.

## Downstream safety

Scene/timeline/render consumers must reference the resulting `asset` version/artifact and verify its `metadata.validated=true`, checksum and trusted storage status. Unvalidated provider outputs must not be passed directly to render inputs.

## Operational checks

Run:

```bash
npm run check
npm test
```

For production, verify `ffprobe` is installed in the worker image, keep artifact storage configured, and apply migration `007_asset_ingestion.sql` before dispatching asset jobs.
