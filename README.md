# Forge Studio: running the workflow

## What is implemented

Forge now has an episode/version domain model, immutable artifacts, provider-run tracking, currency-separated cost records, QA/approval contracts, a bearer-token HTTP API, an optional PostgreSQL schema/repository adapter, a provider registry/runner, a typed scene-plan validator, and a pipeline orchestration example.

## Run the automated test suite

```bash
npm install
npm run check
```

## Run the end-to-end deterministic demo

```bash
npm run demo -- "Why volcanoes erupt"
```

The demo executes all nine stages (research, script, scene plan, narration, assets, timeline, render, QA and publish-record) using deterministic mock providers. It does not call paid vendor APIs, create an actual MP4/audio file, publish to YouTube, or dispatch a real Shorts handoff. The mock publish stage records a simulated dry run only.

## Start the HTTP API

For local experimentation, the API requires an auth token for mutating routes when a token is configured. Set one explicitly:

```bash
API_BEARER_TOKEN=local-dev-secret ALLOW_UNAUTHENTICATED_READS=true npm start
```

Then:

```bash
curl http://localhost:8080/healthz
curl -H 'Authorization: Bearer local-dev-secret' http://localhost:8080/v1/episodes
```

## PostgreSQL mode

Set `DATABASE_URL` to a PostgreSQL connection string and install the optional driver if it is not present:

```bash
npm install
DATABASE_URL='postgres://...' npm run migrate
DATABASE_URL='postgres://...' API_BEARER_TOKEN='replace-with-secret' npm start
```

The migration command is explicit. The server does not automatically mutate a database schema unless `RUN_MIGRATIONS_ON_START=true` is set.

## Provider adapters

Implement `execute(request, context)` and return `{ artifacts, usage, estimatedCost, actualCost, currency }`. Register providers by capability with `ProviderRegistry`. The current default provider implementations are deliberately fake. Integrate Piper, cloud TTS, ComfyUI/OpenVideo, Remotion/FFmpeg, or Manim behind this interface only after licensing, environment and operational requirements are agreed.

## Shorts handoff

`createShortsHandoff` produces a versioned manifest for `akashdnb/purffle-shorts`, but requires an approved/published episode and the exact selected approved render. The manifest contains source episode/render/version identity and candidate clips. A real network dispatcher, destination authentication and asset fetch adapter are not part of this core yet.
