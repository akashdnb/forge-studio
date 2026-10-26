# Whisper transcription worker

Forge transcribes only an **approved, immutable narration artifact**. The worker never reports success when the provider, model, input checksum, or output contract is missing.

## Input contract

The durable job kind is `workflow:transcription`. Its payload requires `episodeId`. The worker resolves the current `kind='narration'` artifact for that episode unless an exact `narrationArtifactId` + `narrationVersionId` is supplied.

A narration artifact must have:

- `metadata.approved=true` after the narration approval gate.
- a non-empty `storageUri`.
- a 64-character SHA-256 `contentHash`.
- an audio media type when media type is present.
- the current narration version in `episodes.current_versions`.

Production downloads are HTTPS-only with redirects disabled. The downloaded bytes are bounded and hashed before Whisper is invoked. `file://` is available only for local tests/development when `FORGE_TRANSCRIPTION_ALLOW_FILE=true`.

## Whisper provider

Configure a real Whisper-compatible CLI:

```text
FORGE_WHISPER_COMMAND=whisper
FORGE_WHISPER_MODEL=turbo
FORGE_WHISPER_ARGS=--model ${model} --output_format json --output_dir ${outDir} ${input}
```

The official OpenAI Whisper CLI accepts an audio path plus `--model`, `--output_dir`, and `--output_format json`, and writes JSON containing timestamped segments. citeturn0search0turn0search2

The command must return Whisper JSON either on stdout or as a `.json` file in `${outDir}`. The JSON must contain `language` and `segments[]`; each segment requires `start`, `end`, and non-empty `text`. `confidence` is accepted directly and `avg_logprob` is converted to a bounded confidence value.

There is intentionally no mock-success fallback. If `FORGE_WHISPER_COMMAND` is absent, the job fails with `PROVIDER_NOT_CONFIGURED`.

## Deterministic output

The persisted transcript uses `forge-transcript-v1`:

```json
{
  "schemaVersion": "forge-transcript-v1",
  "language": "en",
  "durationSeconds": 12.345,
  "segments": [
    {"index":0,"start":0,"end":1.234,"text":"Hello","confidence":0.91}
  ]
}
```

Timestamps are normalized to milliseconds and segment ordering is validated. The canonical JSON is SHA-256 hashed. The transcript version and artifact IDs are content-derived from episode, source narration version, and transcript hash, making retries idempotent and preventing duplicate versions for the same input/output.

## Durable retries

The normal Forge worker leases the job, heartbeats it, and reconciles `SUCCEEDED`/`FAILED` through `JobQueue`. Provider timeouts are retryable; invalid input, checksum mismatches, missing configuration, malformed provider output, and approval/provenance failures are permanent. The persisted artifact is checked before provider execution so a retried job reuses an existing transcript.

The GitHub Actions runner uses `scripts/run-transcription-job.js`. It only accepts a durable `workflow:transcription` job already in `RUNNING`, applies a 20-minute workflow limit plus an internal 14-minute provider limit, and reconciles the job in PostgreSQL. Set repository variable `FORGE_WHISPER_INSTALL=true` to install the official `openai-whisper` package on the ephemeral runner; otherwise `FORGE_WHISPER_COMMAND` must point to an already available Whisper-compatible executable. A pre-signed HTTPS `FORGE_TRANSCRIPTION_OUTPUT_URL` may be supplied for an immutable object-store upload; the uploaded bytes carry their own SHA-256 header.

## GitHub Actions secrets

- `FORGE_DATABASE_URL`
- `FORGE_WHISPER_COMMAND`
- `FORGE_WHISPER_ARGS`
- `FORGE_WHISPER_MODEL`
- optional `FORGE_TRANSCRIPTION_OUTPUT_URL` (pre-signed HTTPS PUT URL)

Repository variable:

- `FORGE_WHISPER_INSTALL=true` to install `openai-whisper` on the ephemeral runner.

Use `workflow_dispatch` with a durable job id or `repository_dispatch` with `client_payload.job_id`. The workflow uses `contents: read`, disables checkout credentials, and does not require `akashdnb/purffle-shorts`.
