# Forge media QA worker

Forge QA is a local deterministic worker stage for rendered long-form MP4 artifacts. It does **not** call a QA provider and never turns an unavailable media file into a success.

## Checks

For every `workflow:qa` job the worker:

1. resolves the immutable render artifact and its version provenance;
2. materializes `file://`, `https://` (allowlisted hosts), or S3-compatible `s3://` objects into a private temporary directory;
3. bounds object size and command execution time;
4. computes SHA-256 over the exact bytes and compares it with the artifact checksum when present;
5. runs `ffprobe` in machine-readable mode and validates an MP4-compatible container, required video/audio streams, codecs, duration, dimensions and audio metadata;
6. runs a full `ffmpeg` decode with strict error detection to catch corrupt/truncated media;
7. persists a structured `forge-media-qa-v1` result against the exact render artifact/version;
8. uses the durable job ID as the QA result idempotency key, so a retry cannot create a second result;
9. fails the job for any failed media check. Only the existing job retry policy can retry transient execution failures.

FFmpeg/ffprobe are treated as untrusted-input processors: the worker has a hard timeout, output limits, object-size limits and no shell execution. HTTP media URIs require `FORGE_QA_ALLOWED_MEDIA_HOSTS` and redirects are disabled to reduce SSRF risk. Production S3 access uses the AWS SDK and supports `FORGE_S3_ENDPOINT` plus `FORGE_S3_FORCE_PATH_STYLE` for S3-compatible stores.

## Expected media metadata

Render artifacts can carry:

```json
{
  "expectedMedia": {
    "durationSeconds": 900,
    "durationToleranceSeconds": 0.5,
    "videoCodec": "h264",
    "audioCodec": "aac",
    "width": 1920,
    "height": 1080,
    "audioSampleRate": 48000,
    "audioChannels": 2,
    "format": "mp4"
  }
}
```

Timeline/render jobs should copy deterministic expected values into render artifact metadata. The QA payload may provide `timelineMetadata` as an explicit override for the same contract.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `FORGE_QA_TIMEOUT_MS` | `600000` | Total timeout for each media operation. |
| `FORGE_QA_MAX_BYTES` | `5368709120` | Maximum object size materialized for QA. |
| `FORGE_QA_ALLOWED_MEDIA_HOSTS` | empty | Comma-separated HTTPS host allowlist. Required for HTTP(S) artifacts. |
| `FORGE_FFPROBE_PATH` | `ffprobe` | ffprobe executable. |
| `FORGE_FFMPEG_PATH` | `ffmpeg` | ffmpeg executable. |
| `FORGE_S3_REGION` | `AWS_REGION`/`us-east-1` | S3 region. |
| `FORGE_S3_ENDPOINT` | unset | Optional S3-compatible endpoint. |
| `FORGE_S3_FORCE_PATH_STYLE` | `false` | Enable path-style S3 addressing. |

The production Docker image installs FFmpeg. The bounded GitHub Actions media-QA workflow installs the same toolchain and runs the complete test suite.

## Workflow contract

`workflow:render` remains the stage that produces the immutable render artifact. `workflow:qa` is now Forge-owned and consumes that artifact directly. `FORGE_STAGE_QA_ENDPOINT` is no longer required for the normal QA path.

A QA result is linked to the exact render `artifact_id` and `version_id`. A passing result is the evidence used by the existing final-render approval gate. `purffle-shorts` is not involved in this path.
