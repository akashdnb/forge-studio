# Forge Studio

Forge Studio is the production control plane for long-form educational video episodes. It owns episode state, immutable versions, artifact provenance, provider runs, QA/approval gates, cost records, durable workflow jobs, publishing and the Forge → `akashdnb/purffle-shorts` derivative contract.

## Production slice

- Durable PostgreSQL persistence with ordered/checksummed migrations.
- Project/channel/style-profile primitives and project membership roles.
- Immutable version/artifact provenance and dependency invalidation.
- First-class research packages, sources and claim provenance.
- Declarative timeline snapshots with deterministic validation and content hashes.
- Bearer-token protected API with project-scoped authorization, readiness/liveness and request IDs.
- Provider registry, timeout/retry/idempotency contracts and HTTP JSON/OpenAI-compatible adapters.
- Durable PostgreSQL job queue with leases, retries, dependency ordering, blocked-job cancellation and crash recovery.
- Async nine-stage episode orchestration: research → script → scene plan → narration → assets → timeline → render → QA → publish.
- Built-in configurable HTTP adapters for generation/QA stages plus a built-in deterministic FFmpeg render stage.
- YouTube publishing adapter using resumable upload and OAuth refresh-token support.
- Lightweight operational dashboard and gated Forge → Shorts handoff.

Forge never records render success from a placeholder response. The render stage must produce a real MP4, verify its checksum/metadata, and persist immutable provenance before the durable render job can succeed.

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

Migration `003_jobs_outbox.sql` adds durable jobs, the transactional outbox and persisted idempotency records. Migration `004_production_workflow.sql` adds research provenance, channels/style profiles, timeline snapshots, storage lifecycle records, publish runs, project membership and workflow-job dependencies.

Jobs are dependency-ordered. Downstream jobs are not claimable until their dependency succeeds; jobs whose dependency permanently fails/cancels are automatically cancelled. Workers lease, heartbeat and recover jobs after crashes.

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

`workflow:render` is handled by Forge's built-in FFmpeg renderer rather than `FORGE_STAGE_RENDER_ENDPOINT`. The handler loads the persisted timeline version, verifies its SHA-256 content hash, validates source paths, runs bounded FFmpeg, produces H.264/AAC MP4 output, computes the output checksum, writes metadata, and persists the render artifact plus storage lifecycle record.

Render artifacts use deterministic IDs derived from the durable job ID (`render:<job-id>`), so retries reconcile the same artifact. Permanent input/provenance errors are not retried; execution failures use the existing bounded job retry/lease lifecycle.

Production worker configuration:

```text
FORGE_RENDER_WORKDIR=/var/lib/forge
FORGE_RENDER_OUTPUT_DIR=/var/lib/forge/renders
FORGE_RENDER_TIMEOUT_MS=900000
```

The Render Blueprint provisions FFmpeg in the production image, runs `node src/worker.js` for the worker service, and mounts a 10 GB persistent render disk at `/var/lib/forge`.

See [`docs/ffmpeg-render-worker.md`](docs/ffmpeg-render-worker.md) for the bounded GitHub Actions executor and reconciliation flow.

## Configure production stage services

The worker registers built-in handlers for `workflow:research`, `workflow:script`, `workflow:scene_plan`, `workflow:narration`, `workflow:assets`, `workflow:timeline`, `workflow:render` and `workflow:qa`. All stages except render can use their configured HTTP provider endpoints. Render is intentionally local and deterministic.

Configure these environment variables on the worker for the HTTP-backed stages:
- `FORGE_STAGE_RESEARCH_ENDPOINT`
- `FORGE_STAGE_SCRIPT_ENDPOINT`
- `FORGE_STAGE_SCENE_PLAN_ENDPOINT`
- `FORGE_STAGE_NARRATION_ENDPOINT`
- `FORGE_STAGE_ASSETS_ENDPOINT`
- `FORGE_STAGE_TIMELINE_ENDPOINT`
- `FORGE_STAGE_QA_ENDPOINT`
- `FORGE_STAGE_PROVIDER_TOKEN` (optional shared bearer token)

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

`render.yaml` declares the authenticated API, durable worker and static dashboard. Set the database/API credentials, HTTP stage endpoint secrets and YouTube OAuth values in Render. Apply migrations before routing production traffic; the blueprint intentionally sets `RUN_MIGRATIONS_ON_START=false`.
