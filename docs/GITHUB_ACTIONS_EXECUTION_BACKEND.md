# GitHub Actions execution backend

Forge treats GitHub Actions as an ephemeral execution backend. PostgreSQL remains the source of truth for durable jobs, workflow stages and immutable artifacts.

## Routing

`workflow:transcription`, `workflow:render`, `workflow:captions`, `workflow:qa` and `workflow:package` are dispatched through task-specific workflow wrappers backed by `.github/workflows/forge-worker.yml`. The wrappers contain no business logic; they invoke the existing production workers.

Each dispatch carries only `job_id`, `episode_id`, `worker_type`, `correlation_id`, `idempotency_key` and an immutable `ref`. The durable job payload is loaded by the bounded runner entrypoint. Secrets are injected only as GitHub Actions secrets and are never written to inputs or logs.

## Durable lifecycle

Migration `007_github_actions_executions.sql` persists execution identity, workflow/ref, correlation/idempotency, GitHub run ID/attempt, timestamps, runner profile, timeout, heartbeat, failure classification and structured metadata. Execution states are `DISPATCHING`, `QUEUED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT` and `STALE`.

The Forge worker claims the durable job before dispatch and reconciles external runs after restarts. Runs are correlated by deterministic workflow `run-name`; if the dispatch response contains no run ID, reconciliation searches recent workflow runs. Stale dispatches are requeued after the grace period, runner failures/timeouts retry within `max_attempts`, and explicit cancellation is terminal.

Completed/failed external executions call the existing `EpisodeWorkflowIntegration` hooks so stage dependencies and downstream dispatch remain consistent with local workers. Artifact creation and provenance remain owned by the task-specific worker implementations.

## Runner callback

The runner can send an authenticated callback to `/internal/github-actions/callback` using `X-Forge-Runner-Token`. Authentication uses a timing-safe comparison and the callback only mutates a known `(job_id, correlation_id)` execution. GitHub polling remains the recovery path when callbacks are delayed or unavailable.

## Local/test mode

`FORGE_GITHUB_ACTIONS_MODE=local` uses a deterministic in-process client and never calls GitHub. Lifecycle tests use fake persistence/queue/client dependencies, so CI does not need production GitHub credentials.

Production configuration:

```text
FORGE_GITHUB_ACTIONS_ENABLED=true
FORGE_GITHUB_ACTIONS_MODE=github
FORGE_GITHUB_REPOSITORY=akashdnb/forge-studio
FORGE_GITHUB_TOKEN=<least-privilege Actions credential>
FORGE_GITHUB_REF=<immutable deployed commit SHA>
```

Configure repository secrets `DATABASE_URL`, `FORGE_RUNNER_CALLBACK_TOKEN`, `FORGE_RUNNER_CALLBACK_URL`, and only the S3/Whisper credentials required by the specific worker. Do not use `secrets: inherit`.

## Deployment

Apply migration 007 before enabling production dispatch. Keep `RUN_MIGRATIONS_ON_START=false`. Pin `FORGE_GITHUB_REF` to the deployed commit SHA instead of a mutable branch so runner code is reproducible.

`render.yaml` contains the production worker/API configuration for the dispatcher and callback token. The GitHub token should have only the repository Actions permissions needed to dispatch/read runs.

## Validation

```bash
npm install --no-audit --no-fund
npm run check
```

`npm run check` includes the execution backend, callback, packaging adapter and bounded runner entrypoint plus the complete Node test suite.
