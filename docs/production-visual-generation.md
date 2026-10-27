# Production visual asset generation

The ASSETS workflow stage now executes the repository's existing provider pipeline for image and video scene shots. It does not create a parallel worker or bypass the generation worker.

## Provider configuration

For each capability, configure either the existing HTTP JSON provider boundary or the existing bounded command-provider boundary:

```text
FORGE_IMAGE_GENERATION_ENDPOINT
FORGE_IMAGE_GENERATION_PROVIDER
FORGE_IMAGE_GENERATION_MODEL
FORGE_IMAGE_GENERATION_CREDENTIAL_NAME
FORGE_IMAGE_GENERATION_TIMEOUT_MS
FORGE_IMAGE_GENERATION_FALLBACK_ENDPOINT
FORGE_IMAGE_GENERATION_FALLBACK_PROVIDER
FORGE_IMAGE_GENERATION_FALLBACK_CREDENTIAL_NAME

FORGE_VIDEO_GENERATION_ENDPOINT
FORGE_VIDEO_GENERATION_PROVIDER
FORGE_VIDEO_GENERATION_MODEL
FORGE_VIDEO_GENERATION_CREDENTIAL_NAME
FORGE_VIDEO_GENERATION_TIMEOUT_MS
FORGE_VIDEO_GENERATION_FALLBACK_ENDPOINT
FORGE_VIDEO_GENERATION_FALLBACK_PROVIDER
FORGE_VIDEO_GENERATION_FALLBACK_CREDENTIAL_NAME
```

Alternatively set the corresponding `*_COMMAND` and `*_ARGS` values for an existing production command adapter. Provider credentials must remain in the credential registry/process environment; request metadata never contains raw secrets.

Tenant-scoped execution requires the existing capability-token and signed provider-contract controls. Provider routing remains behind the existing reliability/health/fallback policies, so an incompatible or quarantined fallback cannot be selected.

## HTTP response contract

A visual provider returns JSON containing an `artifact` (or an artifact-shaped root object) with either `contentBase64`/`base64` or a provider output URL, plus `mediaType`/`contentType`. `requestId` or `request_id` is captured as immutable provenance. Returned bytes are still validated by the canonical generation worker before artifact persistence.

## Shot execution

`workflow:assets` loads the approved immutable scene plan and turns each scene without an existing asset into a deterministic shot specification. The specification includes scene/shot identity, timing, prompt, media capability, style, composition and provider parameters. The shot specification is included in the generation request and artifact metadata, so downstream timeline planning can consume the same immutable visual intent and generated asset version.

Idempotency is based on episode + immutable input versions + normalized shot specification. The existing provider-run and content-addressed artifact identities therefore make worker retries/crash recovery safe and avoid re-uploading identical media. Provider fallback is only available through the existing registered fallback candidates and their admission/health/contract policies.

## Acceptance path

The integration suite includes a real FFmpeg-backed provider process that creates valid MP4 media, feeds it into the existing timeline compiler, and renders the result through the existing FFmpeg renderer. It is a media-producing acceptance fixture, not a mocked byte/signature response. Production deployments must use a configured real provider rather than deterministic mode.
