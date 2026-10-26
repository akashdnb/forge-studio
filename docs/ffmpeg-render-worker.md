# FFmpeg render worker

Forge Studio renders long-form episodes with the built-in FFmpeg stage. `workflow:render` consumes exactly one immutable `render-manifest` artifact produced by `workflow:timeline-manifest`.

The render job payload is intentionally small and immutable:

```json
{
  "episodeId": "episode-123",
  "manifestArtifactId": "manifest:8b7...",
  "actor": "worker"
}
```

The render handler downloads the content-addressed manifest, verifies its storage checksum and `manifestChecksum`, and passes that exact manifest to the FFmpeg renderer. It does not re-read scene plans, timeline snapshots, asset selections, or mutable episode state to reconstruct render inputs. Manifest provenance includes the approved timeline version and every immutable input version.

The renderer produces real H.264/AAC MP4 at 1280x720/30fps, preserves timeline gaps as black video, strips source metadata, computes an output SHA-256 checksum, and writes adjacent JSON metadata. Unsafe or missing source paths are terminal failures. Render execution remains bounded by the configured timeout and the durable job lease/retry lifecycle.

```text
FORGE_RENDER_WORKDIR=/var/lib/forge
FORGE_RENDER_OUTPUT_DIR=/var/lib/forge/renders
FORGE_RENDER_TIMEOUT_MS=900000
```

## Pipeline dependency

`workflow:render` must depend on the successful `workflow:timeline-manifest` job. A retry of the manifest job resolves to the same content-addressed artifact when immutable inputs and compiler configuration are unchanged. A conflicting artifact identity is rejected rather than overwritten.

## Bounded GitHub Actions executor

`.github/workflows/render-media.yml` is a bounded executor for one durable `workflow:render` job. It checks out the exact workflow SHA, claims the requested job with a lease, runs the same renderer, verifies the real MP4/checksum, uploads the MP4 and metadata with `actions/upload-artifact`, and reconciles success or failure to PostgreSQL through the existing job queue.

Configure `DATABASE_URL` and the same storage credentials used by Forge before dispatching it.
