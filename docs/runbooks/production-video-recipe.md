# Production Video Recipe / Render Orchestrator

## Purpose

`video_production_recipes` is the durable recipe record for a real production video. It snapshots the topic, exact stage order, provider/model choices, deterministic parameters, and recipe hash. A recipe can create one or more render attempts; each attempt points at the existing `episode_workflows` execution and records stage timings, provider observations, output artifact/version ids, checksums, and failure provenance.

The implementation intentionally does **not** add another media worker. It uses the existing Script, Scene Plan, Narration, Transcription, Asset, Timeline, Caption, FFmpeg Render, QA, and Packaging handlers plus the existing queue, lease, workflow recovery, and artifact integrity controls.

## API

- `POST /v1/video-recipes` — create an immutable recipe snapshot. Body: `{ episodeId, topic, providerConfig?, options? }`.
- `GET /v1/video-recipes/:id` — reconcile and return the recipe, attempts, and stage runs.
- `POST /v1/video-recipes/:id` — start the recipe. Repeated calls while an attempt is queued/running are idempotent.
- `POST /v1/video-recipes/:id/resume` — invoke existing workflow recovery and reconcile the attempt.
- `GET /v1/video-recipes?episodeId=...` — list recipes for an episode.

Use the normal bearer token plus `x-actor-id` / `x-tenant-id` headers used by the existing API.

## Provider configuration

The recipe stores provider/model names, fallback choices, and whether stage endpoints are configured. Credentials are never copied into the recipe. Existing stage handlers remain authoritative for credential access, timeout, circuit breaker, rate limit, and provider failover.

For HTTP stages, configure the existing `FORGE_STAGE_<STAGE>_ENDPOINT`, `..._FALLBACK_ENDPOINT`, `..._PROVIDER`, `..._FALLBACK_PROVIDER`, and model variables. Narration continues to use the existing TTS provider registry. Render continues to use the existing FFmpeg handler. Captioning and packaging continue to use their existing workers.

## Idempotency / crash recovery

The recipe hash is a stable SHA-256 of the canonical recipe. Recipe creation is keyed by `Idempotency-Key`. Workflow dispatch keeps its existing deterministic `episode-workflow-job:<workflow>:<stage>` keys. Artifact publication remains behind `ArtifactStorageService`, which enforces immutable identity, checksum verification, authenticated integrity manifests, and lineage.

If the worker or process crashes, do not create a second workflow manually. Call `POST /v1/video-recipes/:id/resume`; the existing workflow lease/dependency recovery reclaims expired jobs and redispatches only work that is still eligible. Stage runs are reconciled from the authoritative `episode_workflow_stages` rows.

## Acceptance fixture

Run `node scripts/accept-production-video.js` against a disposable or dedicated database. The fixture refuses to run when the real stage provider endpoints or worker secret boundary are missing. It creates an isolated project/episode, starts the real recipe, approves only the generated Script and Scene Plan versions for the fixture actor, waits for the existing workers to finish, opens the packaged artifact through the trusted artifact gateway, and runs `ffprobe`/FFmpeg-backed media validation. No provider output is synthesized by the fixture.

The final validation requires an MP4 container, H.264 video, AAC audio, positive duration, valid streams, complete decode, and artifact checksum integrity.

## Operational checks

1. Inspect the recipe and stage runs with `GET /v1/video-recipes/:id`.
2. Inspect the linked `episode_workflows` / `forge_jobs` records if a stage is queued or failed.
3. Check provider endpoint configuration and credential grants before changing retry settings.
4. For a render failure, resume the recipe after the underlying provider/storage issue is fixed; never delete an immutable render artifact to force a retry.
5. A packaging success without an artifact id is treated as a production failure.
6. A media QA failure blocks packaging and publication; do not override it by marking the recipe succeeded.

## Migration

Apply migration `163_video_production_recipe_orchestrator.sql` through the existing release-safe migration runner before enabling the API/worker release.
