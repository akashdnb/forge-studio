# GitHub Actions execution backend

Forge treats GitHub Actions as an ephemeral execution backend. PostgreSQL remains the source of truth for jobs, workflow stages and artifacts. The worker dispatches bounded task-specific executions and reconciles their state; business logic remains in the existing Forge worker handlers.

## Durable execution

Migration `007_github_actions_executions.sql` adds `forge_execution_runs` with job/attempt identity, workflow mapping, deterministic correlation/idempotency keys, GitHub run IDs/attempts, runner profile, timeout/heartbeat timestamps, failure classification and structured metadata.

Execution states are `DISPATCHING`, `QUEUED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT` and `STALE`. A Forge job is claimed before dispatch, so Actions is never the queue. The execution record is persisted before the dispatch call; reconciliation can recover after the Render worker restarts and correlate a run by its deterministic `run-name`.

## Routing

| Forge job kind | Worker type | Workflow |
| --- | --- | --- |
| `workflow:transcription` | transcription | `.github/workflows/forge-transcribe.yml` |
| `workflow:render` | media-ffmpeg | `.github/workflows/forge-render.yml` |
| `workflow:captions` | captions | `.github/workflows/forge-caption.yml` |
| `workflow:qa` | qa | `.github/workflows/forge-qa.yml` |
| `workflow:package` | package | `.github/workflows/forge-package.yml` |

The wrappers call `.github/workflows/forge-worker.yml`; they contain no business logic. Successful/failed external jobs invoke the existing `EpisodeWorkflowIntegration` hooks so stage dependencies, blocked-stage handling and downstream dispatch continue to work exactly as they do for local workers. Packaging is routed through the same bounded runner backend while retaining the production packaging worker's provenance/idempotency logic.

## Dispatch contract and security

Workflow inputs contain only `job_id`, `episode_id`, `worker_type`, `correlation_id`, `idempotency_key` and an immutable `ref`. The complete durable job payload is loaded by `scripts/run-github-worker-job.js`. Secrets are injected only through GitHub Actions secrets and are never interpolated into workflow inputs or logged.

The runner sends an authenticated callback to `/internal/github-actions/callback` using `X-Forge-Runner-Token`. Authentication uses a timing-safe comparison and the callback can only mutate a known `(job_id, correlation_id)` execution. GitHub polling remains the recovery path if the callback is unavailable.

## Retry, idempotency and recovery

- Dispatch records are unique per `(job_id, attempt)` and use a deterministic correlation ID.
- GitHub run names contain the correlation ID, allowing reconciliation to find a run even when the dispatch response did not contain a run ID.
- Runner failures and timeouts retry until `max_attempts` is exhausted; non-retryable callback failures can opt out with `metadata.retryable=false`.
- Explicit cancellation is terminal and is not blindly retried.
- A dispatch that remains unobserved beyond the grace period becomes `STALE` and is safely requeued.
- Reconciliation heartbeats the durable job while a runner is queued/in progress and can complete a job after the original worker process has restarted.
- Existing artifact provenance/idempotency remains authoritative; the execution backend never creates a second artifact itself.

## Local/test mode

`FORGE_GITHUB_ACTIONS_MODE=local` uses a deterministic in-process adapter and never contacts GitHub. Tests use fake queue/persistence/client dependencies, so production GitHub credentials are not required in CI.

Production configuration:

```text
FORGE_GITHUB_ACTIONS_ENABLED=true
FORGE_GITHUB_ACTIONS_MODE=github
FORGE_GITHUB_REPOSITORY=akashdnb/forge-studio
FORGE_GITHUB_TOKEN=<least-privilege Actions credential>
FORGE_GITHUB_REF=<immutable deployed commit SHA>
```

The dispatch credential needs only the repository permissions required to dispatch and read workflow runs. Never print or persist it.

## Required GitHub secrets

- `DATABASE_URL` for the existing task-specific handlers;
- `FORGE_RUNNER_CALLBACK_TOKEN` shared with the Forge API;
- `FORGE_RUNNER_CALLBACK_URL` pointing at `/internal/github-actions/callback`;
- S3 credentials for render/QA/transcription/packaging where required;
- Whisper configuration only for transcription.

Wrappers explicitly pass only the secrets needed by their worker. Do not replace these mappings with `secrets: inherit`.

## Deployment

`render.yaml` enables the backend on the Forge worker and adds the GitHub dispatch/ref settings plus the API callback token. Apply migration 007 before enabling production dispatch. Keep `RUN_MIGRATIONS_ON_START=false` and use the normal migration process first.

Pin `FORGE_GITHUB_REF` to the deployed commit SHA. Do not point it at a mutable branch in production; this keeps execution code reproducible.

## Validation

```bash
npm install --no-audit --no-fund
npm run check
```

The check script includes the execution backend, callback handler, packaging adapter and generic runner entrypoint plus the complete Node test suite.
