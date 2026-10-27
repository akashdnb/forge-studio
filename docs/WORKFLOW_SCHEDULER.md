# Workflow Scheduler Operations

Forge's durable scheduler is the production claim path for long-form workflow jobs. It sits between durable PostgreSQL jobs and workers/GitHub Actions dispatch.

## Guarantees
- PostgreSQL `FOR UPDATE SKIP LOCKED` makes multi-scheduler claims race-safe.
- A job moves from `QUEUED` to `RUNNING` atomically with a dispatch token/generation and scheduler event.
- Dependencies must be `SUCCEEDED`; failed/cancelled dependencies cancel descendants.
- Global, project and episode concurrency are enforced at claim time.
- Priority, project load and age-based starvation boosting prevent hot projects from monopolizing capacity.
- Queue-depth backpressure permits urgent/starving work while bounding ordinary dispatch.
- Lease expiry and execution timeout recover retryable attempts and fail exhausted attempts.
- Dispatch generation/token binding prevents stale worker completions from mutating newer attempts.
- Existing approval, QA, budget and publishing gates remain authoritative.

## Configuration
```text
FORGE_SCHEDULER_GLOBAL_CONCURRENCY=8
FORGE_SCHEDULER_PROJECT_CONCURRENCY=3
FORGE_SCHEDULER_EPISODE_CONCURRENCY=2
FORGE_SCHEDULER_MAX_QUEUE_DEPTH=500
FORGE_SCHEDULER_MAX_DISPATCHES_PER_TICK=4
FORGE_SCHEDULER_STARVATION_SECONDS=300
FORGE_SCHEDULER_PRIORITY_BOOST=10
FORGE_SCHEDULER_JOB_TIMEOUT_SECONDS=1800
```

## Health and metrics
Authenticated operators can query `/internal/scheduler/metrics` and `/internal/scheduler/health` with the normal API bearer token. Metrics expose queue depth, runnable/blocked work, retries, p95 dispatch wait, lease expiry, timeout, starvation, backpressure and saturation.

## Recovery and incident response
The worker runs recovery before every dispatch cycle. If starvation grows, inspect queue depth, saturation and dispatch latency. If blocked work grows while workers are idle, inspect dependency terminal states and workflow gates. If lease expiry/timeout grows, inspect heartbeats, runner health and database latency before raising limits.

Never manually set a job to `RUNNING`; use the durable scheduler lifecycle so idempotency, leases and dependency wake-up stay consistent.
