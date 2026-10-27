# Generation Worker

Forge's Generation Worker is the bounded execution boundary for image, video and text generation. PostgreSQL remains authoritative for durable jobs, provider runs, immutable versions and artifact provenance. Providers are adapters only; they never own Forge state.

## Durable contract

Generation jobs use the existing `forge_jobs` lease/retry lifecycle. Supported kinds are:

- `generation:image`
- `generation:video`
- `generation:text`
- `workflow:generation`
- `workflow:assets` when `FORGE_GENERATION_ASSETS_MODE=generation` or the payload contains `generationRequests`.

A generation request must contain a capability, an approved immutable `inputVersionIds` set and a prompt/text/parameters payload. The worker rejects filesystem paths, arbitrary provider URLs, unapproved versions, stale script/scene-plan versions, cross-episode provenance and missing input checksums.

Each logical output gets deterministic identities derived from episode, capability, sorted input versions, request parameters and provider/model identity. The same logical retry therefore reuses the same provider run, version and artifact identity instead of creating a competing output.

## Provider contract

Configured HTTP providers receive JSON:

```json
{
  "contractVersion": "forge-generation-v1",
  "capability": "image|video|text",
  "model": "configured-model",
  "request": {"prompt":"...","parameters":{}},
  "inputVersionIds": ["..."],
  "idempotencyKey": "generation:<sha256>"
}
```

A successful provider returns an `artifact` object. Text uses `artifact.content`; image/video use `artifact.contentBase64` and a supported media type. `contentHash` is optional but, when present, must equal the SHA-256 of the actual output bytes. `storageUri` and filesystem paths are never dereferenced.

The built-in registry supports configured HTTP JSON providers, an OpenAI-compatible text adapter, and a deterministic local provider for test/development mode. Provider selection is configuration-driven and limited to registered capability/provider pairs.

## Retry, timeout and cancellation

The durable job attempt count is the retry budget. Provider failures are classified as retryable only for timeouts, network failures, HTTP 408/425/429 and HTTP 5xx responses. Authentication, authorization, malformed requests, unsupported outputs and provenance errors are terminal. HTTP 429 responses preserve a bounded `Retry-After` delay in the error metadata; the durable worker uses that delay for the next job attempt.

Cancellation is propagated to the provider through `AbortSignal`. The worker polls the durable job state while a provider is running and turns an explicit `CANCELLED` job into a terminal provider cancellation. Timeouts never leave a provider call running after its abort signal is fired.

## Output validation

- Text must be non-empty and stay below configured character/byte limits.
- Images are limited to PNG/JPEG/WebP and are checked for valid magic bytes and dimensions.
- Videos are limited to MP4/WebM/QuickTime and are validated with bounded `ffprobe` for a real video stream, duration, dimensions and codec.
- All binary outputs are bounded before persistence and are checksummed from the actual bytes.
- Provider-supplied checksums must match the computed checksum.
- Secrets are excluded from provider metadata and structured errors.

## Provenance and approval

Input versions are checked against the episode, their immutable content hashes are required, and the corresponding SCRIPT/SCENE_PLAN approval must exist. Current script and scene-plan selections are checked so stale versions cannot generate new descendants. Generated versions add dependency edges to every input version and artifacts retain provider-run and input provenance.

The worker does not select or approve final media. Downstream timeline/render/QA/publishing gates remain responsible for approval and quality decisions.

## Scene-plan integration

When `workflow:assets` is routed through generation, requests may be declared on a scene's visual object:

```json
{
  "visual": {
    "generationRequests": [
      {
        "capability": "image",
        "prompt": "A clean educational diagram of a volcano cross-section",
        "parameters": {"width": 1920, "height": 1080},
        "assetRole": "diagram"
      }
    ]
  }
}
```

The scene-plan version remains the immutable provenance input. If no generation requests are present and generation mode is not enabled for assets, the existing configured assets provider remains the fallback.

## Configuration

See `examples/generation.env.example`. Production provider endpoints and tokens are configuration/secret inputs only. Never put a provider token into a job payload, request metadata, source control, logs or an artifact.

Important bounds:

```text
FORGE_GENERATION_TIMEOUT_MS
FORGE_GENERATION_MAX_ATTEMPTS
FORGE_GENERATION_MAX_REQUESTS
FORGE_GENERATION_MAX_OUTPUT_BYTES
FORGE_GENERATION_MAX_TEXT_CHARS
FORGE_GENERATION_MAX_IMAGE_WIDTH
FORGE_GENERATION_MAX_IMAGE_HEIGHT
FORGE_GENERATION_MAX_VIDEO_DURATION_SECONDS
FORGE_GENERATION_MAX_VIDEO_WIDTH
FORGE_GENERATION_MAX_VIDEO_HEIGHT
FORGE_GENERATION_ASSETS_MODE
```

Use `FORGE_GENERATION_MODE=deterministic` for local/CI tests. This mode never calls external providers and produces stable text, PNG and MP4 fixtures.

## Diagnostics and metrics

Generation events should be correlated by durable job id and provider-run id. Safe metadata includes capability, provider name/model, latency, attempt, output size/checksum, validation result, retry classification and bounded rate-limit delay. Never emit prompts containing secrets or authorization headers. Useful operational counters are provider successes/failures, retryable failures, rate limits, timeouts, cancellations, malformed responses, output-limit failures, stale-input rejections and idempotent reuses.
