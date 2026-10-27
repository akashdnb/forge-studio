# Workflow Scheduler Operations

Forge's durable scheduler is the production claim path for long-form workflow jobs. It sits between durable PostgreSQL jobs and normal workers/GitHub Actions dispatch.

## Guarantees

- PostgreSQL `FOR UPDATE SKIP LOCKED` makes multi-scheduler claims race-safe.
- A job moves from `QUEUED` to `RUNNING` in the same transaction that creates its dispatch token and scheduler event.
- Dependencies must be `SUCCEEDED`; failed/cancelled dependencies cancel descendants instead of bypassing the graph.
- Global, project and episode concurrency are enforced atomically at claim time.
- Priority is ordered with an age-based starvation boost; lower active project load is preferred to prevent project starvation.
- Backpressure limits queue saturation while urgent or starving work remains eligible.
- Lease expiry and bounded execution timeout return retryable work to `QUEUED` and terminally fail exhausted attempts.
- `dispatch_generation` and `dispatch_token` prevent stale worker completions from mutating a newer attempt.
- Existing idempotency keys and provider execution records remain authoritative; the scheduler does not bypass approval, QA, budget or publishing gates.

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

## Metrics and health

Authenticated operators can query `/internal/scheduler/metrics` and `/internal/scheduler/health` with the normal API bearer token. Metrics include queue depth, runnable/blocked work, retry waiting, p95 dispatch wait, lease expiry, timeout, starvation, backpressure and saturation.

## Recovery

The worker calls scheduler recovery before each dispatch cycle. Recovery requeues only genuinely expired leases, never resurrects cancellation-requested work, cancels descendants of failed dependencies, enforces timeout/retry bounds, clears old dispatch tokens, and records durable scheduler events. The GitHub Actions backend claims through the same scheduler.

## Incident response

If runnable work is starving, inspect `starving`, `starvation_events`, dispatch latency, queue depth and saturation. If `blocked` grows while `running` is low, inspect dependency terminal states and workflow stage gates. If lease expiry or timeout grows, inspect worker heartbeats, runner health and database latency before increasing concurrency or timeout limits.

Do not manually set jobs to `RUNNING`; use the scheduler/worker lifecycle so leases, idempotency and dependency wake-up remain consistent.
