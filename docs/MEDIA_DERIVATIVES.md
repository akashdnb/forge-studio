# Media derivatives

Forge Studio now has a durable `workflow:media-derivative` job for deterministic media previews. It consumes an authorized immutable artifact through the production artifact access gateway and persists the result through the existing content-addressed artifact storage service.

## Supported recipes

- `poster`: one deterministic JPEG poster frame.
- `contact-sheet`: bounded JPEG contact sheet with at most 12 frames.
- `waveform`: deterministic PNG waveform from the first audio stream.
- `proxy`: bounded 640x360 H.264/AAC MP4 proxy, capped at the configured duration.
- `clip`: bounded 640x360 H.264/AAC MP4 preview clip.

A derivative identity is SHA-256 of `forge-derivative`, the lowercase source SHA-256, and the SHA-256 of the canonical recipe/version. The resulting artifact ID is `derivative:<identity>`. Retries and duplicate jobs therefore converge on one immutable output.

## Job contract

Enqueue through the normal durable job queue with:

```json
{
  "kind": "workflow:media-derivative",
  "projectId": "project-id",
  "episodeId": "episode-id",
  "idempotencyKey": "media-derivative:<source-sha>:<recipe-hash>",
  "payload": {
    "sourceArtifactId": "immutable-artifact-id",
    "recipe": {
      "type": "poster",
      "timestampSeconds": 4.25
    }
  }
}
```

The job is dependency- and lease-managed by the existing scheduler/worker runtime. The worker re-checks project/episode scope, artifact lifecycle, provenance reachability, storage status and approval policy before reading bytes. Storage keys are never accepted from the job payload.

## Safety boundary

Inputs are streamed through the artifact gateway and bounded before FFmpeg. The worker verifies the source SHA-256, probes the real media bytes with `ffprobe`, rejects malformed metadata, unsupported codecs/containers, excessive duration/dimensions/stream counts and oversized inputs, then executes FFmpeg without a shell. Outputs are bounded, re-probed, checksummed and stored as immutable artifacts. Partial work directories are removed in `finally` blocks.

Quarantined, deletion-pending and deleted artifacts are never readable. Non-approved user delivery is still blocked by the artifact gateway. Internal worker reads use the `purpose=worker` path but still require a configured worker actor and project membership.

## Configuration

- `FORGE_ARTIFACT_WORKER_ACTORS`: comma-separated trusted worker identities used by the artifact gateway.
- `FORGE_DERIVATIVE_WORKDIR`: bounded scratch directory; defaults to the OS temporary directory.
- `FORGE_DERIVATIVE_TIMEOUT_MS`: FFmpeg execution timeout; default 300000.
- `FORGE_DERIVATIVE_MAX_INPUT_BYTES`: input byte cap; default 2 GiB.
- `FORGE_DERIVATIVE_MAX_OUTPUT_BYTES`: output byte cap; default 512 MiB.
- `FORGE_DERIVATIVE_MAX_INPUT_DURATION_SECONDS`: source duration cap; default 3600.
- `FORGE_DERIVATIVE_MAX_PROXY_SECONDS`: proxy duration cap; default 900.
- `FORGE_DERIVATIVE_MAX_PREVIEW_SECONDS`: clip duration cap; default 30.
- `FORGE_FFPROBE_COMMAND` / `FFPROBE_PATH` and `FFMPEG_PATH`: real media executables.

Keep the scratch volume separate from durable artifact storage and enforce an OS/container disk quota. The worker never exposes a filesystem path as an artifact reference.

## Operations

Monitor `workflow:media-derivative` queue depth, generic Forge job failure/retry metrics, artifact upload/download byte counters, FFmpeg duration and storage failures. A cache hit means the immutable derivative row and READY artifact already exist; no media process should be launched.

If a derivative is missing or corrupt, do not mutate the artifact. Quarantine/reconcile it using the existing media lifecycle reconciler and enqueue the same deterministic job again. The identity lock prevents concurrent generation of the same derivative.

For cancellation, set the durable job cancellation flag. The worker polls that flag while downloading and while FFmpeg runs, kills the process, removes the scratch directory and leaves no partial artifact. Lease expiry is handled by the existing worker recovery path; a retry reuses the same derivative identity.
