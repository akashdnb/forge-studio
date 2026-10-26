# Forge media QA worker

Forge QA is a deterministic worker stage for rendered long-form MP4 artifacts. It does not call a QA provider and never turns unavailable or corrupt media into success.

## Checks

For every `workflow:qa` job the worker resolves the immutable render artifact/version provenance, materializes `file://`, allowlisted HTTPS, or S3-compatible `s3://` media into a private temporary directory, enforces size/time/output limits, computes SHA-256, validates MP4 container/codec/streams/duration/dimensions/audio metadata with `ffprobe`, and performs a strict full `ffmpeg` decode to detect corruption/truncation. Results use `forge-media-qa-v1` and the durable job ID as the idempotency key.

HTTP media requires `FORGE_QA_ALLOWED_MEDIA_HOSTS`; redirects are disabled and private/link-local resolutions are rejected. S3 uses the AWS SDK with optional `FORGE_S3_ENDPOINT` and path-style addressing.

## Expected metadata

```json
{"expectedMedia":{"durationSeconds":900,"durationToleranceSeconds":0.5,"videoCodec":"h264","audioCodec":"aac","width":1920,"height":1080,"audioSampleRate":48000,"audioChannels":2,"format":"mp4"}}
```

Expected values can come from immutable render artifact metadata/version payload or an explicit QA `timelineMetadata` payload.

## Configuration

- `FORGE_QA_TIMEOUT_MS` — default `600000`.
- `FORGE_QA_MAX_BYTES` — default `5368709120`.
- `FORGE_QA_ALLOWED_MEDIA_HOSTS` — comma-separated HTTPS host allowlist.
- `FORGE_FFPROBE_PATH` / `FORGE_FFMPEG_PATH` — optional executable overrides.
- `FORGE_S3_REGION`, `FORGE_S3_ENDPOINT`, `FORGE_S3_FORCE_PATH_STYLE` — S3-compatible storage configuration.

The production Docker image includes FFmpeg. `.github/workflows/media-qa.yml` installs FFmpeg and runs the full test suite with a 15-minute workflow bound.

`workflow:render` produces the immutable artifact; `workflow:qa` is Forge-owned and validates that artifact directly. `FORGE_STAGE_QA_ENDPOINT` is not required. A passing QA result is the evidence used by the existing final-render approval gate. `purffle-shorts` is not a dependency.
