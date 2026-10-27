# Generation Worker

The Generation Worker owns the `ASSETS` workflow stage (`workflow:assets`) and also exposes `workflow:generation` for direct operational jobs. It accepts only immutable, approved version IDs and produces immutable generated versions plus artifacts.

## Provider contract

Each capability (`image`, `video`, `text`) selects one configured adapter:

- `deterministic`: local/test-only, byte-for-byte deterministic output.
- `http-json`: bounded synchronous JSON adapter. The endpoint receives `{ model, input }` and must return either `{ output: ... }` or `{ artifact: ... }`. Binary outputs use base64 plus `mediaType`; text outputs use `text` or `content`.

The worker never accepts provider URLs as output. Providers must return the bytes through the adapter so checksum, size and media validation happen before persistence.

## Configuration

```text
FORGE_GENERATION_LOCAL_MODE=false
FORGE_GENERATION_IMAGE_PROVIDER=http-json
FORGE_GENERATION_IMAGE_ENDPOINT=https://provider.example/image
FORGE_GENERATION_IMAGE_MODEL=image-model
FORGE_GENERATION_IMAGE_API_KEY=<secret>
FORGE_GENERATION_VIDEO_PROVIDER=http-json
FORGE_GENERATION_VIDEO_ENDPOINT=https://provider.example/video
FORGE_GENERATION_VIDEO_MODEL=video-model
FORGE_GENERATION_VIDEO_API_KEY=<secret>
FORGE_GENERATION_TEXT_PROVIDER=http-json
FORGE_GENERATION_TEXT_ENDPOINT=https://provider.example/text
FORGE_GENERATION_TEXT_MODEL=text-model
FORGE_GENERATION_TEXT_API_KEY=<secret>
FORGE_GENERATION_PROVIDER_TIMEOUT_MS=120000
FORGE_GENERATION_PROVIDER_MAX_ATTEMPTS=3
FORGE_GENERATION_MAX_IMAGE_BYTES=26214400
FORGE_GENERATION_MAX_VIDEO_BYTES=209715200
FORGE_GENERATION_MAX_TEXT_CHARS=20000
```

`FORGE_GENERATION_LOCAL_MODE=true` is intended for tests and local development. In production, every capability must have an explicit provider configuration.

## Input contract

A generation job must contain:

```json
{
  "episodeId": "episode-id",
  "inputVersionIds": ["approved-scene-plan-version"],
  "requests": [
    { "capability": "image", "input": "prompt/spec", "metadata": {} }
  ]
}
```

When `requests` is omitted, the worker reads `generationRequests` or `assetRequests` from the approved scene-plan payload. Every input version must belong to the episode and have a latest `APPROVED` approval. The episode must be in `GENERATION` state.

## Reliability and idempotency

The logical output identity is SHA-256 over episode, capability, provider/model, request and sorted immutable input version IDs. Provider runs use the same identity as their idempotency key. Replayed jobs/callbacks therefore reuse the existing successful artifact instead of creating a second logical output. Conflicting bytes for an existing identity fail closed.

Provider attempts are bounded to five at most (three by default). HTTP 408/425/429/5xx and network failures are retryable. HTTP 4xx, malformed responses, unsupported media, empty/corrupt output and configured size violations are terminal. `Retry-After` is honored and capped at 60 seconds.

Timeout and cancellation are propagated to the adapter through `AbortSignal`. The worker polls the durable job row for cancellation while a provider call is active. Provider execution metadata contains provider/model/attempt/latency/output identity only; API keys and other secrets are never persisted in provider-run requests, artifacts, logs or error metadata.

## Artifact and provenance rules

Binary image/video output is streamed into the configured immutable artifact store with a SHA-256 expectation. Text output is stored as an immutable caption artifact. Generated versions depend on every input version, and artifacts point back to the generated version, provider run and immutable input IDs.

Downstream timeline/render stages consume the workflow stage outputs through the existing `EpisodeWorkflowIntegration`; the worker never advances or bypasses approval gates itself.

## Worker registration

`npm run worker` now uses `scripts/run-worker.js`, which composes the existing worker handlers with the generation handlers. Existing worker lease, heartbeat, retry, usage accounting and workflow integration behavior remains in `src/worker.js`.

## Diagnostics

Monitor provider-run status, error code, attempt count, duration and generated-output counts. Safe operational error fields are limited to classification code, bounded message, retryability and retry-after. Never log provider request headers, API keys, raw prompts containing secrets, or raw generated media.
