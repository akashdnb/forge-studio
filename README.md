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
- Transactional outbox and request-idempotency persistence primitives.
- Async nine-stage episode orchestration: research → script → scene plan → narration → assets → timeline → render → QA → publish.
- Production YouTube publishing adapter using resumable upload and OAuth refresh-token support.
- Lightweight operational dashboard under `public/`.
- Forge → Shorts handoff manifest gated on the exact approved render.

The remaining media-generation/rendering providers remain explicit worker adapters. Forge does not fake paid vendor capabilities: deployments register the stage handlers that match their selected LLM/TTS/asset/render infrastructure.

## Validate locally

```bash
npm install
npm run check
npm run demo -- "Why volcanoes erupt"
```

The demo is deterministic and uses mock providers. It does not call paid APIs, create a real MP4/audio file, publish to YouTube, or dispatch a Shorts handoff.

## Run the API

```bash
API_BEARER_TOKEN=local-dev-secret ALLOW_UNAUTHENTICATED_READS=true npm start
```

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl -H 'Authorization: Bearer local-dev-secret' http://localhost:8080/v1/episodes
```

For production, configure `API_BEARER_TOKEN` and keep unauthenticated reads disabled. Supply `X-Actor-Id` with the authenticated actor identity; project membership is enforced server-side for persistent routes.

## PostgreSQL + worker

```bash
DATABASE_URL='postgres://...' npm run migrate
DATABASE_URL='postgres://...' npm start
DATABASE_URL='postgres://...' npm run worker
```

Migration `003_jobs_outbox.sql` adds durable jobs, the transactional outbox and persisted idempotency records. Migration `004_production_workflow.sql` adds research provenance, channels/style profiles, timeline snapshots, storage lifecycle records, publish runs, project membership and workflow-job dependencies.

Workflow jobs are dependency-ordered. A downstream job is not claimable until its dependency succeeds; jobs whose dependency permanently fails/cancels are automatically cancelled. Workers lease, heartbeat and recover jobs after crashes.

## Workflow API

Start the durable pipeline for an episode:

```http
POST /v1/episodes/:episodeId/workflow
Authorization: Bearer ...
X-Actor-Id: ...
Content-Type: application/json

{"brief":"A 15 minute educational episode about volcanoes"}
```

Inspect jobs with `GET /v1/jobs` or `GET /v1/jobs/:id`.

Research is persisted as an immutable version plus source/claim records:

- `POST /v1/episodes/:episodeId/research`
- `GET /v1/episodes/:episodeId/research`

Timeline snapshots are validated and persisted through:

- `POST /v1/episodes/:episodeId/timeline`
- `GET /v1/episodes/:episodeId/timeline`

## YouTube publishing

Publishing is only accepted for an exact approved render with a passing QA result. Forge creates an idempotent `publish_run`, moves the episode into `PUBLISHING`, and queues the upload for the worker.

Configure either a current access token or an OAuth refresh token plus client credentials:

```text
YOUTUBE_ACCESS_TOKEN
YOUTUBE_REFRESH_TOKEN
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
```

The publisher uses YouTube's resumable upload flow and reconciles an existing external video ID before creating another upload. Google recommends offline OAuth access/refresh tokens for server-side applications that need to act when the user is not present.

## Provider adapters

Implement `execute(request, context)` and return normalized artifacts and usage/cost metadata. `src/pipeline/http-provider.js` supplies a timeout/retry-safe JSON adapter and an OpenAI-compatible chat adapter. Provider credentials must be injected through environment/secret management; never commit them.

For long-running production stages, set `FORGE_WORKER_HANDLERS` to a module exporting a `handlers` object keyed by workflow job kind, for example `workflow:script`, `workflow:render` and `workflow:qa`. The worker loop owns durability/retries; the stage handler owns the vendor-specific execution and artifact persistence contract.

## Forge → Shorts

`POST /v1/episodes/:episodeId/shorts/handoff` emits the versioned manifest only after the episode is approved/published and the exact approved render is selected. The manifest preserves source episode/render/version identity and candidate segments and explicitly grants no publication permission to Shorts.

`purffle-shorts` remains independently deployable. Forge is the authoritative source for the long-form render and provenance; Shorts is the derivative generation/distribution system. A network dispatcher can consume the handoff manifest through the configured integration boundary without making long-form completion depend on Shorts publishing.

## Dashboard

The `public/` dashboard is a deliberately small operational UI for connection configuration, readiness, episode creation and episode inspection. It is not a replacement for the full editorial script/scene/timeline editor described by the architecture model.

## Render deployment

`render.yaml` defines the authenticated API, durable worker and static dashboard. Configure `DATABASE_URL`, `API_BEARER_TOKEN`, `CORS_ORIGIN`, `FORGE_WORKER_HANDLERS` and the YouTube OAuth secrets in Render. Apply migrations before exposing the API to traffic, or explicitly opt into `RUN_MIGRATIONS_ON_START=true` when that operational policy is acceptable.
