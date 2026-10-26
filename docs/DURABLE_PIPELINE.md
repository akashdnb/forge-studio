# Forge Studio durable pipeline operations

## Capabilities in this release slice

Forge's source now contains an episode/version domain core, an HTTP API, optional PostgreSQL persistence, database-enforced provenance constraints, a leased PostgreSQL workflow queue, a worker loop, provider adapter boundaries, a deterministic mock workflow, and an approved-render-gated Shorts manifest.

## API jobs (PostgreSQL mode)

- `POST /v1/episodes/{episodeId}/jobs` enqueues a workflow stage and returns HTTP 202.
- `GET /v1/episodes/{episodeId}/jobs?status=QUEUED&limit=50&offset=0` lists stage jobs.
- `GET /v1/jobs/{jobId}` checks the durable job state.
- `POST /v1/jobs/{jobId}/cancel` cancels a non-terminal job.

Requests require the configured bearer token for writes. These endpoints are only durable when the API is started with `DATABASE_URL`; in-memory mode returns explicit not-configured responses for durable job actions.

## Worker lease model

The PostgreSQL queue uses `FOR UPDATE SKIP LOCKED` to claim work without two workers claiming the same row concurrently. Claims create a lease, heartbeat and completion require the current worker's non-expired lease, and expired leases can be reclaimed only while attempts remain. Expired jobs that exhausted their attempt limit are marked failed. Failure retries only when explicitly marked retryable and bounded by `max_attempts`.

A queue claim is not proof that a provider executed successfully. Providers must return an artifact array; exceptions cause retry/failure recording. The current worker's provider-run/artifact ledger is process-local, while the durable queue result is in PostgreSQL. The next storage integration must persist provider-run and artifact rows in the same completion transaction/outbox before treating them as canonical. Do not use this worker as a paid multi-tenant workflow executor until that integration is finished.

## Running API and worker

The Render Blueprint defines separate API and background worker services sharing `DATABASE_URL`. Before sync/deploy:

1. Provision PostgreSQL in the intended Render environment and apply migrations with `npm run migrate`.
2. Set a strong, unique `API_BEARER_TOKEN` secret on the API service.
3. Keep `FORGE_ALLOW_MOCK_PROVIDERS=false` outside demo/sandbox. Mock stages produce JSON placeholders, not real media.
4. Install FFmpeg/Piper and configure explicit model/output paths only after validating host dependencies, model/voice licensing, storage retention and disk capacity.
5. Validate the Blueprint in RenderUtils before syncing; never assume a successful CI run means Render resources were deployed.

The current Docker image uses the slim Node Alpine base. FFmpeg/Piper binaries and voice models are not bundled. A deployment that enables these adapters needs a separate image build/infrastructure choice and explicit model-license review.

## Media boundaries

- `FfmpegRenderer` runs binaries without a shell, constrains local paths to an output root, bounds logs, applies process timeouts and returns ffprobe metadata.
- `PiperTtsProvider` invokes an explicitly installed Piper executable/model, removes stale output before generation, constrains output paths, applies a timeout and produces an audio artifact record.
- These adapters are primitives. A Remotion composition renderer, actual image/video generator, secure asset store and speech/scene alignment algorithm still need implementation before real episode rendering is end-to-end.

## Migration behavior

Numbered SQL migrations are append-only once shared. The migrator checksums and records each file. Existing migration files contain transaction boundaries for direct `psql -f` use; the migration runner executes each file as a complete multi-statement query, then inserts its migration-ledger row. The schema changes are largely idempotent to allow safe retry if the process stops between the SQL file and ledger insert. This boundary is not a distributed transaction; inspect failed migration status before retrying.

## CI

`npm run check` runs syntax checks and the Node test suite without provider credentials. `npm run demo -- "Why volcanoes erupt"` completes the nine workflow stages using mock providers and explicitly does not publish or create actual video/audio media.
