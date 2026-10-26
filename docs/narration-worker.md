# Narration / TTS worker

`workflow:narration` turns the currently approved immutable `script` version into an immutable audio artifact. It is registered in the durable worker alongside transcription, captions, rendering and publishing handlers.

## Input and provenance

The worker requires `payload.episodeId` and consumes `episodes.current_versions.script`. The version must have a matching `approvals` row with `stage='SCRIPT'` and `decision='APPROVED'`. The script content hash is captured in the narration provenance and in the deterministic idempotency fingerprint. A stale script, missing hash, missing approval, or missing narration text is rejected before provider execution.

## Provider configuration

The worker uses the existing `ProviderRegistry` capability abstraction with capability `tts`.

- Production: set `FORGE_TTS_COMMAND` and optionally `FORGE_TTS_ARGS`, `FORGE_TTS_MODEL`, `FORGE_TTS_VOICE`. The command receives a JSON request file through `${input}` and must write the generated audio to `${output}`. This adapter allows a real provider SDK/CLI to be selected without embedding provider credentials in Forge.
- Local/test: register the deterministic provider or set `FORGE_TTS_MODE=deterministic` / `NODE_ENV=test`. It generates a stable PCM WAV from the approved text and requires no credentials.
- `FORGE_TTS_TIMEOUT_MS` bounds provider execution. `FORGE_TTS_MAX_TEXT_CHARS` bounds input size.

Provider stderr is truncated and provider secrets are never included in Forge logs. Do not put API keys in command arguments; use the provider's environment/credential mechanism instead.

## Acceptance gate

No artifact is published until the returned bytes are validated. The worker verifies non-empty/non-silent content, media type, container/codec, positive duration, channel count, sample rate and SHA-256. WAV is parsed directly; other formats are inspected with `ffprobe`. The stored artifact is written through `ArtifactStorageService`, which verifies the upload checksum and creates the trusted storage record.

Metadata schema `forge-narration-v1` records the source script version/hash, input fingerprint, provider/model/voice, duration, container, codec, sample rate, channels, byte count and checksum. `inputVersionIds` links the artifact to the approved script.

## Retry and idempotency

The artifact identity is `narration-audio:<fingerprint>` where the fingerprint includes the approved script version/hash and normalized TTS configuration. Re-running the same approved input/configuration returns the existing artifact instead of creating a second output. A conflicting artifact identity fails closed with `IDEMPOTENCY_CONFLICT`.

Provider timeouts and provider-unavailable errors are marked retryable; malformed audio, invalid provenance, unsupported media and cancellation are terminal. Failed or cancelled provider output is never persisted. The durable queue's existing lease/heartbeat/retry lifecycle remains the source of truth for job attempts.

## Job kind

Use `workflow:narration` and pass:

```json
{
  "episodeId": "episode-id",
  "scriptVersionId": "optional-explicit-approved-script-version",
  "voice": "optional-provider-voice",
  "format": "audio/wav"
}
```

The resulting audio artifact uses artifact kind `audio` and version-record kind `narration`; downstream timeline/render consumers can use its immutable artifact/version/checksum metadata.
