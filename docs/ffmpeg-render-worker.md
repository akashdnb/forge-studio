# FFmpeg render worker

Forge Studio renders long-form episodes with the built-in FFmpeg stage. `workflow:render` no longer depends on `FORGE_STAGE_RENDER_ENDPOINT`.

The handler re-reads the persisted immutable timeline version, verifies its SHA-256 hash, rejects unsafe source paths, and renders only that snapshot. Render version and artifact IDs are deterministic (`render:<job-id>`), so retries reconcile the same artifact. Provenance conflicts and invalid inputs are permanent failures; execution failures use the existing durable lease/retry lifecycle.

The renderer produces real H.264/AAC MP4 at 1280x720/30fps, preserves timeline gaps as black video, strips source metadata, computes an output SHA-256 checksum, and writes adjacent JSON metadata. The worker persists the binary through Forge's existing content-addressed local/S3-compatible storage abstraction while `/var/lib/forge` is used only as bounded scratch space.

```text
FORGE_RENDER_WORKDIR=/var/lib/forge
FORGE_RENDER_OUTPUT_DIR=/var/lib/forge/renders
FORGE_RENDER_TIMEOUT_MS=900000
```

## Bounded GitHub Actions executor

`.github/workflows/render-media.yml` is a single bounded executor for one durable `workflow:render` job. It checks out the exact workflow SHA, claims the requested job with a lease, runs the same renderer, verifies the real MP4/checksum, uploads the MP4 and metadata with `actions/upload-artifact`, and explicitly reconciles success or failure to PostgreSQL through the existing job queue. It is not a long-lived worker and does not depend on `purffle-shorts`.

The job payload remains the source of truth; mutable timeline JSON is never supplied by the workflow input. Configure the repository `DATABASE_URL` secret and the same storage credentials used by Forge before dispatching it.
