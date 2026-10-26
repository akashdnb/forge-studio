# GitHub Actions execution backend

Forge treats GitHub Actions as an ephemeral execution backend. PostgreSQL remains the source of truth for jobs, versions and artifacts. The worker only dispatches bounded task-specific executions and reconciles their state; business logic remains in the existing Forge worker handlers.

## Durable execution record

Migration `007_github_actions_executions.sql` adds `forge_execution_runs`. Each row records the durable job, attempt, logical worker type, workflow, correlation/idempotency identity, GitHub run ID/attempt, runner profile, timestamps, timeout, failure classification and structured metadata.

Execution states are:

`DISPATCHING → QUEUED → IN_PROGRESS → COMPLETED`

with `FAILED`, `CANCELLED`, `TIMED_OUT` and `STALE` terminal states.

A GitHub Actions run is never the queue. A Forge job is claimed first, its execution identity is persisted, and only then is the workflow dispatched. If the Render worker restarts, reconciliation can complete or retry the job without requiring the original worker process to own the job lease.

## Routing

| Forge job kind | Worker type | Workflow |
| --- | --- | --- |
| `workflow:transcription` | transcription | `.github/workflows/forge-transcribe.yml` |
| `workflow:render` | media-ffmpeg | `.github/workflows/forge-render.yml` |
| `workflow:captions` | captions | `.github/workflows/forge-caption.yml` |
| `workflow:qa` | qa | `.github/workflows/forge-qa.yml` |

The workflow wrappers call the reusable `.github/workflows/forge-worker.yml`. They do not reimplement transcription, rendering, captioning or QA business logic.

## Dispatch contract

Only these values are passed as workflow inputs:

- durable `job_id`;
- `episode_id`;
- logical `worker_type`;
- deterministic `correlation_id`;
- durable `idempotency_key`;
- immutable Forge `ref`.

The full job payload is read from Forge persistence by the bounded worker entrypoint. Secrets are passed only through GitHub Actions secrets and are never interpolated into log messages.

## Completion and reconciliation

The runner sends an authenticated callback to `/internal/github-actions/callback` using `X-Forge-Runner-Token`. The callback is authenticated with a timing-safe comparison and can only update a known `(job_id, correlation_id)` execution. GitHub Actions polling remains authoritative for recovery: the dispatcher correlates runs by the deterministic workflow `run-name`, observes queued/in-progress/completed states, and reconciles failures, cancellation and timeout.

A missing callback therefore does not lose the job. Conversely, a duplicate callback is harmless because terminal execution records are immutable from the callback path.

## Retry and stale-run handling

- Runner failures and timeouts are retryable until the durable job's `max_attempts` is exhausted.
- Explicit workflow cancellation is terminal and is not blindly retried.
- A dispatch that is persisted but never observed becomes `STALE` after the dispatch grace period and is safely requeued.
- Reconciliation heartbeats the durable Forge job while a runner is queued/in progress.
- A completed external execution can finish the durable job even after the original Render worker process has restarted.
- Existing worker artifact idempotency remains authoritative; retries do not create a second immutable artifact for the same logical input/output identity.

## Local/test mode

Set `FORGE_GITHUB_ACTIONS_MODE=local` to use the deterministic in-process execution adapter. It does not require a GitHub token and never performs a network request. Unit tests use this mode and fake persistence/client objects, so CI does not require production GitHub credentials.

Production uses:

```text
FORGE_GITHUB_ACTIONS_ENABLED=true
FORGE_GITHUB_ACTIONS_MODE=github
FORGE_GITHUB_REPOSITORY=akashdnb/forge-studio
FORGE_GITHUB_TOKEN=<Actions-dispatch credential>
FORGE_GITHUB_REF=<immutable deployed commit SHA>
```

`FORGE_GITHUB_TOKEN` should have only the repository permissions needed to dispatch and reconcile Actions workflows. Do not print it, put it in job inputs, or store it in artifacts.

## GitHub configuration

Configure these repository secrets:

- `DATABASE_URL` — existing Forge persistence connection used by the current task-specific workers;
- `FORGE_RUNNER_CALLBACK_TOKEN` — shared internal callback credential, also configured on the Forge API as `FORGE_RUNNER_CALLBACK_TOKEN`;
- `FORGE_RUNNER_CALLBACK_URL` — Forge callback endpoint, for example `https://<forge-api-host>/internal/github-actions/callback`;
- S3 credentials and worker-specific Whisper settings only for workflows that need them.

The wrapper workflows explicitly map only the secrets needed by that worker. Never use `secrets: inherit` for these production workflows.

## Deployment

`render.yaml` enables the backend on the Forge worker and adds the GitHub dispatch/ref configuration plus the API callback token. Apply migration 007 before enabling production dispatch. Keep `RUN_MIGRATIONS_ON_START=false` in production and run the normal migration process first.

The GitHub ref must point to the deployed Forge commit rather than an arbitrary mutable branch. This keeps the worker code and durable execution contract reproducible.

## Operational checks

Use the normal Forge validation command:

```bash
npm install --no-audit --no-fund
npm run check
```

`npm run check` includes syntax checks for the execution backend/callback and the full Node test suite, including `test/github-actions-backend.test.js`.
