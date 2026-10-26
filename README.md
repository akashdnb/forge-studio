# Forge Studio

Forge Studio is the production control plane for long-form educational video episodes. It owns episode state, immutable versions, artifact provenance, provider runs, QA/approval gates, cost records, durable workflow jobs, publishing and the Forge → `akashdnb/purffle-shorts` derivative contract.

## Production slice

- Durable PostgreSQL persistence with ordered/checksummed migrations.
- Project/channel/style-profile primitives and project membership roles.
- Immutable version/artifact provenance and dependency invalidation.
- Content-addressed artifact storage with local and S3-compatible backends, bounded streaming I/O and checksum verification.
- First-class research packages, sources and claim provenance.
- Declarative timeline snapshots with deterministic validation and content hashes.
- Bearer-token protected API with project-scoped authorization, readiness/liveness and request IDs.
- Provider registry, timeout/retry/idempotency contracts and HTTP JSON/OpenAI-compatible adapters.
- Durable PostgreSQL job queue with leases, retries, dependency ordering, blocked-job cancellation and crash recovery.
- Async episode orchestration: research → script → scene plan → narration → transcription → assets → timeline → captions → render → QA → publish.
- Production media lifecycle reconciliation with bounded scans, checksum/provenance verification, stale lease recovery, orphan partial cleanup, duplicate-output diagnostics and auditable idempotent repairs.
- Real bounded Whisper-compatible transcription worker with immutable input checksum verification and deterministic transcript artifacts.
- Built-in configurable HTTP adapters for generation stages plus a Forge-owned deterministic media QA worker.
- Deterministic captions worker downstream of transcript/timeline provenance.
- YouTube publishing adapter using resumable upload and OAuth refresh-token support.
- Lightweight operational dashboard and gated Forge → Shorts handoff.

Forge media QA validates real rendered MP4 bytes with FFmpeg/ffprobe. It does not fake success or require a QA provider endpoint. See `docs/MEDIA_QA.md` for the contract, resource limits, S3-compatible storage settings and security boundary. Media lifecycle recovery is documented in `docs/MEDIA_RECONCILIATION.md`.

## Validate locally

```bash
npm install
npm run check
npm run demo -- "Why volcanoes erupt"
```

The deterministic demo uses mock providers. It does not call paid APIs, create a real MP4/audio file, publish to YouTube, or dispatch a Shorts handoff.

## Run the API

```bash
API_BEARER_TOKEN=local-dev-secret ALLOW_UNAUTHENTICATED_READS=true npm start
```

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl -H 'Authorization: Bearer local-dev-secret' http://localhost:8080/v1/episodes
```

For production, configure `API_BEARER_TOKEN` and keep unauthenticated reads disabled. `X-Actor-Id` is currently the application actor identifier used for project membership checks; put the API behind a trusted identity-aware gateway or replace this mapping with a verified identity claim before exposing the service to untrusted clients.

## PostgreSQL + worker

```bash
DATABASE_URL='postgres://...' npm run migrate
DATABASE_URL='postgres://...' npm start
DATABASE_URL='postgres://...' npm run worker
```

Migration `003_jobs_outbox.sql` adds durable jobs, the transactional outbox and persisted idempotency records. Migration `004_production_workflow.sql` adds research provenance, channels/style profiles, timeline snapshots, storage lifecycle records, publish runs, project membership and workflow-job dependencies. Migration `005_captions.sql` adds deterministic caption provenance and lifecycle; migration `006_artifact_storage.sql` adds trusted storage keys, checksum status and reconciliation metadata; migration `007_media_reconciliation.sql` adds durable reconciliation runs and repair records.

Jobs are dependency-ordered. Downstream jobs are not claimable until their dependency succeeds; jobs whose dependency permanently fails/cancels are automatically cancelled. Workers lease, heartbeat and recover jobs after crashes. The media reconciler also audits expired leases and recent terminal jobs without resurrecting cancelled or superseded work.

## Artifact storage

Configure the worker with `FORGE_STORAGE_DRIVER=local` for development/tests or `FORGE_STORAGE_DRIVER=s3` in production. See [`docs/ARTIFACT_STORAGE.md`](docs/ARTIFACT_STORAGE.md) for the full contract and configuration.

The worker accepts binary provider results as `artifact.contentBase64` plus `mediaType` and optional `contentHash`. Forge streams the bytes through a bounded SHA-256 verifier, derives an immutable content-addressed key, persists trusted storage metadata and resolves later through the artifact/version graph. Provider-supplied `storageUri` values are not opened or followed, preventing path traversal and SSRF-style storage access.

## Production media reconciliation

The worker periodically audits active and recently completed jobs. It verifies referenced artifacts by provenance and real checksum, records `MISSING`/`CORRUPT` storage state, recovers expired leases, repairs inconsistent terminal job state, flags duplicate logical outputs, and removes only stale local `.part` files. Immutable artifacts and approved outputs are never silently replaced. See `docs/MEDIA_RECONCILIATION.md` for the operator runbook and bounded configuration.

An on-demand reconciliation is a normal durable job: enqueue `workflow:media-reconcile` with an optional reason payload. Reconciliation uses a PostgreSQL advisory lock, deterministic repair fingerprints and the same worker lease/retry lifecycle as other production jobs.

## Real Whisper transcription

Transcription is a first-class durable job (`workflow:transcription`) between narration and timeline. The worker resolves the current approved narration artifact, verifies its SHA-256 checksum after a bounded HTTPS download, runs a real configured Whisper-compatible command, validates timestamped segments/language/confidence, and persists an immutable `transcript` version plus artifact. Retries are idempotent and cannot create duplicate transcript versions for the same source/output.

A narration artifact must explicitly carry `metadata.approved=true` after its approval gate. Configure the worker with a real Whisper implementation:

```bash
FORGE_WHISPER_COMMAND=whisper
FORGE_WHISPER_MODEL=turbo
FORGE_WHISPER_ARGS='--model ${model} --output_format json --output_dir ${outDir} ${input}'
FORGE_TRANSCRIPTION_TIMEOUT_MS=840000
FORGE_TRANSCRIPTION_MAX_INPUT_BYTES=2147483648
FORGE_TRANSCRIPTION_MAX_OUTPUT_BYTES=67108864
```

There is no fake-success fallback. Missing provider/model/input/checksum or malformed provider output fails the job clearly. See `docs/transcription-worker.md` for the full contract and GitHub Actions runner configuration.

## Workflow API

Start the durable pipeline for an episode:

```http
POST /v1/episodes/:episodeId/workflow
Authorization: Bearer ...
X-Actor-Id: ...
Content-Type: application/json

{"brief":"A 15 minute educational episode about volcanoes"}
```

Inspect jobs using `GET /v1/jobs` or `GET /v1/jobs/:id`.

Research is persisted as an immutable version plus source/claim records:
- `POST /v1/episodes/:episodeId/research`
- `GET /v1/episodes/:episodeId/research`

Timeline snapshots are validated and persisted through:
- `POST /v1/episodes/:episodeId/timeline`
- `GET /v1/episodes/:episodeId/timeline`

## Production render

`workflow:render` is handled by Forge's built-in FFmpeg renderer, not a configurable render provider. The handler re-reads the persisted immutable timeline version, verifies its SHA-256 content hash, validates source paths, runs bounded FFmpeg, preserves timeline gaps, produces H.264/AAC MP4 output, computes the output checksum, and persists the binary through Forge's existing content-addressed storage abstraction. The render artifact, storage object and render version retain the exact timeline version/hash provenance.

Render version and artifact IDs are deterministic (`render:<job-id>`), so retries reconcile the same immutable artifact. Permanent input/provenance errors are not retried; execution failures use the existing durable lease/retry lifecycle. The worker uses `/var/lib/forge` as bounded scratch space while production binaries are persisted to the configured S3-compatible backend.

```text
FORGE_RENDER_WORKDIR=/var/lib/forge
FORGE_RENDER_OUTPUT_DIR=/var/lib/forge/renders
FORGE_RENDER_TIMEOUT_MS=900000
```

See [`docs/ffmpeg-render-worker.md`](docs/ffmpeg-render-worker.md) for the bounded GitHub Actions executor. It claims a specific durable render job, runs the same renderer, verifies the real MP4/checksum, uploads the MP4 and metadata as a bounded Actions artifact, and explicitly reconciles success/failure to the durable job queue.

## Configure production stage services

The worker registers HTTP handlers for `workflow:research`, `workflow:script`, `workflow:scene_plan`, `workflow:narration`, `workflow:assets` and `workflow:timeline`. `workflow:qa` is Forge-owned and directly validates the render artifact, so `FORGE_STAGE_QA_ENDPOINT` is not required. It also registers `workflow:captions`, the local Whisper `workflow:transcription` handler, the built-in FFmpeg `workflow:render` handler and `workflow:media-reconcile`.

Configure these environment variables on the worker for provider-backed stages:
- `FORGE_STAGE_RESEARCH_ENDPOINT`
- `FORGE_STAGE_SCRIPT_ENDPOINT`
- `FORGE_STAGE_SCENE_PLAN_ENDPOINT`
- `FORGE_STAGE_NARRATION_ENDPOINT`
- `FORGE_STAGE_ASSETS_ENDPOINT`
- `FORGE_STAGE_TIMELINE_ENDPOINT`
- `FORGE_STAGE_PROVIDER_TOKEN` (optional shared bearer token)

Provider endpoints accept POST JSON with `contractVersion: "forge-stage-v1"`, `stage`, `capability`, `payload` and job metadata. JSON artifacts may use `artifact.content`. Binary artifacts must use `artifact.contentBase64`, with optional `id`, `versionId`, `contentHash`, `mediaType`, `inputVersionIds` and `metadata`. A provider may not supply a filesystem path or arbitrary URL for Forge to fetch. Non-2xx responses are retried only for timeout, 408, 429 and 5xx responses.

Custom handlers can still be loaded via `FORGE_WORKER_HANDLERS`. Custom handlers override built-in handlers by job kind.

## YouTube publishing

Publishing requires the exact approved render and a passing QA result. Forge creates an idempotent `publish_run`, moves the episode to `PUBLISHING`, and queues the upload for the worker.

Configure either a current access token or a refresh token plus client credentials:
```text
YOUTUBE_ACCESS_TOKEN
YOUTUBE_REFRESH_TOKEN
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
```

The publisher uses YouTube's resumable upload flow and reconciles a known external video ID before creating another upload. Start with private uploads until the OAuth scopes, channel, quota, metadata and compliance settings are verified.

## Forge → Shorts

`POST /v1/episodes/:episodeId/shorts/handoff` emits the versioned manifest only after the episode is approved/published and the exact approved render is selected. It preserves source episode/render/version identity and candidate segments and explicitly grants no publication permission to Shorts.

Forge remains authoritative for long-form provenance; `purffle-shorts` is the derivative generation/distribution system. The manifest is the contract boundary rather than an assumption about a network endpoint in the Shorts service.

## Dashboard and deployment

The `public/` UI supports connection configuration, readiness, episode creation and episode inspection. It is not yet the full editorial script/scene/timeline editor.

`render.yaml` declares the authenticated API, worker and static dashboard. The worker image includes FFmpeg. Configure database/API credentials, provider endpoint secrets, artifact storage configuration, Whisper settings, QA bounds/host allowlist, reconciliation bounds, S3-compatible storage credentials and YouTube OAuth values in Render. Apply migrations before routing production traffic; the blueprint intentionally sets `RUN_MIGRATIONS_ON_START=false`.
