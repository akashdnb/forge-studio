# Production Generation Worker

Forge's generation worker owns bounded image, video, and text provider execution for long-form episode assets.

## Job contract

Jobs use `generation:image`, `generation:video`, `generation:text`, or the workflow `workflow:assets` kind. Payloads must include `episodeId`, `inputVersionIds`, and a capability (`image-generation`, `video-generation`, or `text-generation`) for direct generation jobs. Workflow asset jobs default to image generation when no capability is supplied.

Inputs are immutable `version_records` and must belong to the episode, be current, and have an `APPROVED` approval. The worker never accepts mutable source URLs or bypasses workflow approval/QA gates.

## Providers

Providers implement the existing `ProviderRegistry` contract: `execute(request, context)`. Production command adapters are configured independently for each capability:

- `FORGE_IMAGE_GENERATION_COMMAND`, `FORGE_IMAGE_GENERATION_ARGS`, `FORGE_IMAGE_GENERATION_PROVIDER`, `FORGE_IMAGE_GENERATION_MODEL`
- `FORGE_VIDEO_GENERATION_COMMAND`, `FORGE_VIDEO_GENERATION_ARGS`, `FORGE_VIDEO_GENERATION_PROVIDER`, `FORGE_VIDEO_GENERATION_MODEL`
- `FORGE_TEXT_GENERATION_COMMAND`, `FORGE_TEXT_GENERATION_ARGS`, `FORGE_TEXT_GENERATION_PROVIDER`, `FORGE_TEXT_GENERATION_MODEL`

Commands receive a private JSON request file and write a bounded output file. Secrets must be supplied through the provider's environment and are never included in request metadata, logs, or persisted provider metadata.

For deterministic local/test execution set `FORGE_GENERATION_MODE=deterministic` (or `NODE_ENV=test`). The deterministic providers are local-only fixtures and must not be used for production output.

## Safety and reliability

The worker enforces provider selection, immutable input provenance, output media/type validation, checksum calculation, content-addressed logical identity, bounded output size/text/dimensions/duration, timeout and cancellation propagation, retry classification, rate-limit backoff, and idempotent provider runs/artifacts. Terminal validation errors are not retried.

Provider execution metadata records provider/model, input fingerprint, output count, duration, checksums, and validation metadata without secrets or raw provider responses.

## Operational configuration

Useful bounds:

- `FORGE_GENERATION_TIMEOUT_MS`
- `FORGE_GENERATION_MAX_ATTEMPTS`
- `FORGE_GENERATION_MAX_OUTPUT_BYTES`
- `FORGE_GENERATION_MAX_TEXT_CHARS`
- `FORGE_GENERATION_MAX_WIDTH`
- `FORGE_GENERATION_MAX_HEIGHT`
- `FORGE_GENERATION_MAX_DURATION_SECONDS`
- `FORGE_GENERATION_RETRY_BASE_MS`

The worker is registered through the existing `FORGE_WORKER_HANDLERS` extension point using `src/generation/worker-handlers.js`. The registered handler persists immutable artifacts through the canonical artifact storage service and returns version/artifact IDs for workflow dependency advancement.

## Diagnostics

Metrics emitted by the worker include `forge_generation_success`, `forge_generation_failure`, and `forge_generation_retry`, tagged only with capability, provider name, and retry reason. Provider secrets and raw response bodies are deliberately excluded.
