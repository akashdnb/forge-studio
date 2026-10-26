# Forge Studio

Forge Studio is the production control plane for long-form educational video episodes. It owns episode state, immutable versions, artifact provenance, provider runs, QA/approval gates, cost records and the Forge → `akashdnb/purffle-shorts` derivative contract.

## Current production slice

- Durable PostgreSQL persistence with ordered/checksummed migrations.
- Immutable version/artifact provenance and database integrity guards.
- Bearer-token protected HTTP API with readiness/liveness checks and request IDs.
- Provider registry, retry/timeout/idempotency contracts and a generic HTTP JSON provider adapter.
- Executable nine-stage deterministic workflow reference using mock providers.
- Durable PostgreSQL job queue with leases, retries, worker ownership and crash recovery.
- Transactional outbox and request-idempotency persistence primitives.
- Lightweight operational dashboard under `public/`, deployable as a Render static site.
- Forge → Shorts handoff manifest gated on the exact approved render.

The remaining external capabilities are intentionally adapter boundaries: real LLM/TTS/image/video/render/storage/publishing credentials and vendor-specific implementations must be configured for a deployment. Forge does not fake those capabilities.

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

For production, configure `API_BEARER_TOKEN` and keep unauthenticated reads disabled.

## PostgreSQL + worker

```bash
npm install
DATABASE_URL='postgres://...' npm run migrate
DATABASE_URL='postgres://...' npm start
DATABASE_URL='postgres://...' npm run worker
```

Migration `003_jobs_outbox.sql` adds durable jobs, a transactional outbox and persisted idempotency records. Jobs are claimed with PostgreSQL row locks and `SKIP LOCKED`, leased to a worker, heartbeated, retried up to their configured limit, and recovered after lease expiry.

The worker is intentionally handler-driven. Register real stage handlers around the existing pipeline contracts rather than embedding vendor logic in the worker loop.

## Dashboard

The `public/` dashboard is a deliberately small operational UI for connection configuration, readiness, episode creation and episode inspection. It stores only the API URL/token in browser local storage and sends the token directly to the configured Forge API. It is not a replacement for a full editorial timeline UI.

## Provider adapters

Implement `execute(request, context)` and return normalized artifacts and usage/cost metadata. `src/pipeline/http-provider.js` supplies a timeout/retry-safe JSON adapter and an OpenAI-compatible chat adapter. Provider credentials must be injected through environment/secret management; never commit them.

## Shorts handoff

`createShortsHandoff` emits a versioned manifest for `akashdnb/purffle-shorts` only after the episode is approved/published and the exact approved render is selected. The manifest preserves source episode/render/version identity and candidate segments. It deliberately grants no publication permission to Shorts.

A network dispatcher and destination-specific asset fetcher remain integration adapters: they should be deployed only after the destination authentication and storage contracts are configured.

## Render deployment

`render.yaml` now defines three services: the authenticated API, a durable worker and the static dashboard. Set `DATABASE_URL` and `API_BEARER_TOKEN` as Render secrets. Apply migrations before exposing the API to traffic, or explicitly opt into `RUN_MIGRATIONS_ON_START=true` when that operational policy is acceptable.
