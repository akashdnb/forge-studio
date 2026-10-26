# FFmpeg render worker

Forge Studio renders long-form episodes with the built-in FFmpeg stage. `workflow:render` no longer depends on `FORGE_STAGE_RENDER_ENDPOINT`.

## Immutable render input

The render handler consumes the timeline artifact produced by the timeline stage. It verifies the timeline SHA-256 content hash before invoking FFmpeg and records the timeline version ID and hash on the render artifact and storage object. Timeline source files must be relative paths under `FORGE_RENDER_WORKDIR`; absolute paths and `..` traversal are rejected.

A render job has deterministic IDs derived from the durable job ID:

- render version: `render:<job-id>`
- render artifact: `render:<job-id>`

A retry therefore reconciles the same artifact instead of creating a second render. If the existing artifact's immutable provenance does not match the current timeline, the job fails permanently.

## FFmpeg output

The renderer produces a real H.264/AAC MP4 at 1280x720/30fps. It strips source metadata, uses a fixed codec configuration, computes a SHA-256 checksum over the resulting bytes, and writes adjacent JSON metadata. The worker persists the artifact in `artifacts` and `storage_objects` and uses the configured persistent Render disk by default.

Configure:

```text
FORGE_RENDER_WORKDIR=/var/lib/forge
FORGE_RENDER_OUTPUT_DIR=/var/lib/forge/renders
FORGE_RENDER_TIMEOUT_MS=900000
FFMPEG_PATH=ffmpeg                 # optional override
```

The production Render Blueprint provisions a 10 GB worker disk at `/var/lib/forge`.

## Bounded GitHub Actions executor

`.github/workflows/render-media.yml` is an optional bounded executor for a specific durable `workflow:render` job. It:

1. checks out the exact workflow SHA;
2. installs dependencies and validates FFmpeg;
3. claims exactly the requested job with a lease;
4. runs the same production render handler;
5. verifies the persisted MP4, checksum and metadata;
6. uploads the real MP4 and metadata with `actions/upload-artifact`;
7. explicitly reconciles `SUCCEEDED` or `FAILED` back to the durable job queue.

It is a single bounded job, not a long-lived worker. Configure the repository `DATABASE_URL` secret before dispatching it.

```bash
node scripts/run-render-job.js <job-id>
node scripts/verify-render-job.js <job-id>
node scripts/reconcile-render-job.js <job-id> SUCCEEDED
```

Do not pass mutable timeline data directly to the bounded executor. The job payload is the source of truth and the handler verifies the immutable timeline artifact hash before rendering.

## Failure and retry semantics

FFmpeg failures and transient execution failures remain owned by the existing durable job queue. The worker heartbeat/lease recovery logic is unchanged. A bounded GitHub Actions failure calls the same queue failure path, which requeues the job until `max_attempts` is exhausted and then records `FAILED`. Missing inputs, hash mismatches, provenance conflicts and invalid paths are non-retryable.

The renderer never records success merely because FFmpeg exited zero: a non-empty MP4, checksum and metadata must exist before the artifact is persisted. The bounded workflow additionally verifies the persisted artifact before declaring the job successful.
