# Workflow Scheduler Operations

Forge's durable scheduler is the production claim path for long-form workflow jobs. It sits between durable PostgreSQL jobs and workers/GitHub Actions dispatch.

## Guarantees
- `FOR UPDATE SKIP LOCKED` makes multi-scheduler claims race-safe.
- Claim, lease, timeout deadline, dispatch token/generation and scheduling event are committed together.
- Dependencies must be `SUCCEEDED`; failed/cancelled dependencies are cancelled.
- Global/project/episode concurrency, priority, fair project load, starvation prevention and queue-depth backpressure are enforced before dispatch.
- Lease expiry and bounded execution timeout recover retryable attempts and fail exhausted attempts.
- Completion/heartbeat/retry are bound to the current dispatch token so stale workers cannot mutate a newer attempt.
- Existing approval, QA, usage/budget and publishing gates remain authoritative.

## Configuration
`FORGE_SCHEDULER_GLOBAL_CONCURRENCY`, `FORGE_SCHEDULER_PROJECT_CONCURRENCY`, `FORGE_SCHEDULER_EPISODE_CONCURRENCY`, `FORGE_SCHEDULER_MAX_QUEUE_DEPTH`, `FORGE_SCHEDULER_MAX_DISPATCHES_PER_TICK`, `FORGE_SCHEDULER_STARVATION_SECONDS`, `FORGE_SCHEDULER_PRIORITY_BOOST`, and `FORGE_SCHEDULER_JOB_TIMEOUT_SECONDS` control bounded scheduling.

## Health and metrics
Authenticated operators can query `/internal/scheduler/metrics` and `/internal/scheduler/health` with the normal API bearer token. Metrics include queue depth, runnable/blocked work, retry waiting, p95 dispatch wait, lease expiry, timeout, starvation, backpressure and saturation.

## Recovery
The worker runs scheduler recovery before every dispatch cycle. Inspect saturation/dispatch latency for starvation; inspect dependency terminal states for blocked work; inspect heartbeats, runner health and database latency for lease/timeout growth. Never manually set jobs to `RUNNING`.
